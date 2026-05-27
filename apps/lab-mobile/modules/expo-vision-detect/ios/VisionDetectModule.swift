import ExpoModulesCore
import Vision
import UIKit
import CoreImage

public final class VisionDetectModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoVisionDetect")

    // Run all enabled detectors on the image at `uri`. Returns timings and
    // results in a single round-trip so the caller can run them in parallel.
    // Bounding boxes are returned in normalized image coordinates with
    // origin top-left (i.e. already converted from Vision's bottom-left).
    AsyncFunction("detect") { (uri: String, opts: [String: Any]) -> [String: Any] in
      let wantFaces = (opts["faces"] as? Bool) ?? true
      let wantText = (opts["text"] as? Bool) ?? true
      let wantBarcodes = (opts["barcodes"] as? Bool) ?? true
      let wantRectangles = (opts["rectangles"] as? Bool) ?? false

      guard let image = loadCGImage(uri: uri) else {
        throw VisionDetectError.imageLoadFailed
      }
      let width = image.width
      let height = image.height

      let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])

      var requests: [VNRequest] = []
      let faceReq = VNDetectFaceRectanglesRequest()
      if wantFaces { requests.append(faceReq) }
      let textReq = VNRecognizeTextRequest()
      textReq.recognitionLevel = .accurate
      textReq.usesLanguageCorrection = true
      if wantText { requests.append(textReq) }
      let barcodeReq = VNDetectBarcodesRequest()
      if wantBarcodes { requests.append(barcodeReq) }
      let rectReq = VNDetectRectanglesRequest()
      rectReq.maximumObservations = 16
      rectReq.minimumConfidence = 0.7
      if wantRectangles { requests.append(rectReq) }

      let t0 = Date()
      try handler.perform(requests)
      let elapsedMs = Int(Date().timeIntervalSince(t0) * 1000)

      var faces: [[String: Any]] = []
      if wantFaces {
        for obs in (faceReq.results ?? []) {
          faces.append([
            "box": flipBox(obs.boundingBox),
            "confidence": obs.confidence,
          ])
        }
      }

      var textBlocks: [[String: Any]] = []
      if wantText {
        for obs in (textReq.results ?? []) {
          let top = obs.topCandidates(1).first
          textBlocks.append([
            "text": top?.string ?? "",
            "box": flipBox(obs.boundingBox),
            "confidence": top?.confidence ?? obs.confidence,
          ])
        }
      }

      var barcodes: [[String: Any]] = []
      if wantBarcodes {
        for obs in (barcodeReq.results ?? []) {
          barcodes.append([
            "payload": obs.payloadStringValue ?? "",
            "symbology": String(describing: obs.symbology.rawValue),
            "box": flipBox(obs.boundingBox),
            "confidence": obs.confidence,
          ])
        }
      }

      var rectangles: [[String: Any]] = []
      if wantRectangles {
        for obs in (rectReq.results ?? []) {
          rectangles.append([
            "box": flipBox(obs.boundingBox),
            "confidence": obs.confidence,
          ])
        }
      }

      return [
        "width": width,
        "height": height,
        "elapsedMs": elapsedMs,
        "faces": faces,
        "textBlocks": textBlocks,
        "barcodes": barcodes,
        "rectangles": rectangles,
      ]
    }
  }
}

enum VisionDetectError: Error, LocalizedError {
  case imageLoadFailed
  var errorDescription: String? {
    switch self {
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
  guard let data = try? Data(contentsOf: url),
        let img = UIImage(data: data) else { return nil }
  // Bake the EXIF orientation into the CGImage so Vision boxes line up with
  // what the user sees in a normal <Image> tag.
  if let normalized = img.normalizedUpOrientation()?.cgImage { return normalized }
  return img.cgImage
}

// Vision uses normalized coords with origin at the bottom-left; flip to top-left.
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
