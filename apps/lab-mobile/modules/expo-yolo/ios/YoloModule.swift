import ExpoModulesCore
import Vision
import CoreML
import UIKit
import AudioToolbox

public final class YoloModule: Module {
  private var visionModel: VNCoreMLModel?
  private var loadError: String?
  private var currentModelName: String = ""

  public func definition() -> ModuleDefinition {
    Name("ExpoYolo")

    OnCreate {
      AudioServicesDisposeSystemSoundID(1108)
      self.loadModel(name: "YOLO26n")
    }

    Function("isReady") { () -> Bool in
      return self.visionModel != nil
    }

    Function("loadError") { () -> String? in
      return self.loadError
    }

    Function("currentModel") { () -> String in
      return self.currentModelName
    }

    // List available models in the bundle.
    Function("availableModels") { () -> [String] in
      var models: [String] = []
      // Check main bundle and ExpoYoloModels resource bundle.
      let bundles: [Bundle] = [
        Bundle.main,
        Bundle.main.url(forResource: "ExpoYoloModels", withExtension: "bundle")
          .flatMap { Bundle(url: $0) },
      ].compactMap { $0 }
      for b in bundles {
        if let urls = b.urls(forResourcesWithExtension: "mlmodelc", subdirectory: nil) {
          for url in urls {
            let name = url.deletingPathExtension().lastPathComponent
            if !models.contains(name) { models.append(name) }
          }
        }
      }
      return models.sorted()
    }

    // Switch to a different model at runtime.
    AsyncFunction("switchModel") { (name: String) -> Bool in
      self.loadModel(name: name)
      return self.visionModel != nil
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
      // YOLO was trained with letterbox preprocessing; scaleFit matches.
      request.imageCropAndScaleOption = .scaleFit

      // Optional region-of-interest. JS passes a top-left-origin rect in
      // normalized image coords; Vision expects bottom-left origin. The
      // resulting observations are still normalized to the full image,
      // so the caller doesn't need to remap.
      if let roi = opts["roi"] as? [String: Any],
         let rx = (roi["x"] as? Double).map({ CGFloat($0) }),
         let ry = (roi["y"] as? Double).map({ CGFloat($0) }),
         let rw = (roi["width"] as? Double).map({ CGFloat($0) }),
         let rh = (roi["height"] as? Double).map({ CGFloat($0) }) {
        let clampedX = max(0, min(1 - 0.001, rx))
        let clampedY = max(0, min(1 - 0.001, ry))
        let clampedW = max(0.001, min(1 - clampedX, rw))
        let clampedH = max(0.001, min(1 - clampedY, rh))
        let visionY = 1.0 - clampedY - clampedH
        request.regionOfInterest = CGRect(x: clampedX, y: visionY, width: clampedW, height: clampedH)
      }

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

  private func loadModel(name: String) {
    self.loadError = nil
    self.visionModel = nil
    self.currentModelName = ""
    do {
      let candidates: [URL?] = [
        Bundle.main.url(forResource: name, withExtension: "mlmodelc"),
        Bundle.main.url(forResource: name, withExtension: "mlmodelc", subdirectory: "ExpoYoloModels.bundle"),
        {
          if let bundleURL = Bundle.main.url(forResource: "ExpoYoloModels", withExtension: "bundle"),
             let b = Bundle(url: bundleURL) {
            return b.url(forResource: name, withExtension: "mlmodelc")
          }
          return nil
        }(),
      ]
      guard let modelURL = candidates.compactMap({ $0 }).first else {
        self.loadError = "\(name).mlmodelc not found in app bundle"
        return
      }
      let config = MLModelConfiguration()
      config.computeUnits = .all
      let mlModel = try MLModel(contentsOf: modelURL, configuration: config)
      self.visionModel = try VNCoreMLModel(for: mlModel)
      self.currentModelName = name
    } catch {
      self.loadError = "Model load failed: \(error.localizedDescription)"
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
