import ExpoModulesCore
import Vision
import CoreML
import UIKit
import AudioToolbox

public final class YoloModule: Module {
  private var visionModel: VNCoreMLModel?
  private var loadError: String?

  public func definition() -> ModuleDefinition {
    Name("ExpoYolo")

    OnCreate {
      // Silence the camera shutter sound app-wide. Sound ID 1108 is the
      // shutter on iOS — disposing it once suppresses the click that
      // AVCapturePhotoOutput plays on every takePictureAsync.
      AudioServicesDisposeSystemSoundID(1108)

      do {
        // CocoaPods resource_bundle ships the compiled model as
        // ExpoYoloModels.bundle/YOLOv8n.mlmodelc next to the main bundle.
        let candidates: [URL?] = [
          Bundle.main.url(forResource: "YOLOv8n", withExtension: "mlmodelc"),
          Bundle.main.url(forResource: "YOLOv8n", withExtension: "mlmodelc", subdirectory: "ExpoYoloModels.bundle"),
          {
            if let bundleURL = Bundle.main.url(forResource: "ExpoYoloModels", withExtension: "bundle"),
               let b = Bundle(url: bundleURL) {
              return b.url(forResource: "YOLOv8n", withExtension: "mlmodelc")
            }
            return nil
          }(),
        ]
        guard let modelURL = candidates.compactMap({ $0 }).first else {
          self.loadError = "YOLOv8n.mlmodelc not found in app bundle"
          return
        }
        let config = MLModelConfiguration()
        config.computeUnits = .all
        let mlModel = try MLModel(contentsOf: modelURL, configuration: config)
        self.visionModel = try VNCoreMLModel(for: mlModel)
      } catch {
        self.loadError = "Model load failed: \(error.localizedDescription)"
      }
    }

    Function("isReady") { () -> Bool in
      return self.visionModel != nil
    }

    Function("loadError") { () -> String? in
      return self.loadError
    }

    AsyncFunction("detect") { (uri: String, opts: [String: Any]) -> [String: Any] in
      guard let vModel = self.visionModel else {
        throw YoloError.notReady(self.loadError ?? "model not loaded")
      }
      guard let image = loadCGImage(uri: uri) else {
        throw YoloError.imageLoadFailed
      }
      let minConfidence = (opts["minConfidence"] as? Double).map { Float($0) } ?? 0.25

      let request = VNCoreMLRequest(model: vModel)
      // YOLOv8 was trained with letterbox preprocessing; scaleFit matches.
      request.imageCropAndScaleOption = .scaleFit

      let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
      let t0 = Date()
      try handler.perform([request])
      let elapsedMs = Int(Date().timeIntervalSince(t0) * 1000)

      var detections: [[String: Any]] = []
      for case let obs as VNRecognizedObjectObservation in (request.results ?? []) {
        guard let top = obs.labels.first, top.confidence >= minConfidence else { continue }
        detections.append([
          "label": top.identifier,
          "confidence": top.confidence,
          "box": flipBox(obs.boundingBox),
        ])
      }

      return [
        "width": image.width,
        "height": image.height,
        "elapsedMs": elapsedMs,
        "detections": detections,
      ]
    }
  }
}

enum YoloError: Error, LocalizedError {
  case notReady(String)
  case imageLoadFailed
  var errorDescription: String? {
    switch self {
    case .notReady(let why): return "YOLO not ready: \(why)"
    case .imageLoadFailed: return "Could not load image from URI"
    }
  }
}

private func loadCGImage(uri: String) -> CGImage? {
  let url: URL
  if uri.hasPrefix("file://") {
    url = URL(string: uri)!
  } else if uri.hasPrefix("/") {
    url = URL(fileURLWithPath: uri)
  } else if let u = URL(string: uri) {
    url = u
  } else {
    return nil
  }
  guard let data = try? Data(contentsOf: url), let img = UIImage(data: data) else { return nil }
  if let normalized = img.normalizedUpOrientation()?.cgImage { return normalized }
  return img.cgImage
}

private func flipBox(_ b: CGRect) -> [String: CGFloat] {
  return [
    "x": b.origin.x,
    "y": 1.0 - b.origin.y - b.size.height,
    "width": b.size.width,
    "height": b.size.height,
  ]
}

private extension UIImage {
  func normalizedUpOrientation() -> UIImage? {
    if imageOrientation == .up { return self }
    UIGraphicsBeginImageContextWithOptions(size, false, scale)
    draw(in: CGRect(origin: .zero, size: size))
    let out = UIGraphicsGetImageFromCurrentImageContext()
    UIGraphicsEndImageContext()
    return out
  }
}
