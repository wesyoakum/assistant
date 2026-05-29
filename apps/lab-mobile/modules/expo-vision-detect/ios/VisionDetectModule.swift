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

    // --- Body Pose ---
    AsyncFunction("detectBodyPose") { (uri: String) -> [String: Any] in
      guard let image = loadCGImage(uri: uri) else {
        throw VisionDetectError.imageLoadFailed
      }
      let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
      let request = VNDetectHumanBodyPoseRequest()

      let t0 = Date()
      try handler.perform([request])
      let elapsedMs = Int(Date().timeIntervalSince(t0) * 1000)

      var bodies: [[String: Any]] = []
      for obs in (request.results ?? []) {
        var joints: [String: [String: Any]] = [:]
        let allPoints = try obs.recognizedPoints(.all)
        for (key, point) in allPoints {
          if point.confidence > 0.1 {
            joints[key.rawValue.rawValue] = [
              "x": point.location.x,
              "y": 1.0 - point.location.y,
              "confidence": point.confidence,
            ]
          }
        }
        bodies.append(["joints": joints])
      }

      return [
        "width": image.width,
        "height": image.height,
        "elapsedMs": elapsedMs,
        "bodies": bodies,
      ]
    }

    // --- Hand Pose ---
    AsyncFunction("detectHandPose") { (uri: String) -> [String: Any] in
      guard let image = loadCGImage(uri: uri) else {
        throw VisionDetectError.imageLoadFailed
      }
      let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
      let request = VNDetectHumanHandPoseRequest()
      request.maximumHandCount = 4

      let t0 = Date()
      try handler.perform([request])
      let elapsedMs = Int(Date().timeIntervalSince(t0) * 1000)

      var hands: [[String: Any]] = []
      for obs in (request.results ?? []) {
        var joints: [String: [String: Any]] = [:]
        let allPoints = try obs.recognizedPoints(.all)
        for (key, point) in allPoints {
          if point.confidence > 0.1 {
            joints[key.rawValue.rawValue] = [
              "x": point.location.x,
              "y": 1.0 - point.location.y,
              "confidence": point.confidence,
            ]
          }
        }
        hands.append(["joints": joints])
      }

      return [
        "width": image.width,
        "height": image.height,
        "elapsedMs": elapsedMs,
        "hands": hands,
      ]
    }

    // --- Face Landmarks ---
    AsyncFunction("detectFaceLandmarks") { (uri: String) -> [String: Any] in
      guard let image = loadCGImage(uri: uri) else {
        throw VisionDetectError.imageLoadFailed
      }
      let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
      let request = VNDetectFaceLandmarksRequest()

      let t0 = Date()
      try handler.perform([request])
      let elapsedMs = Int(Date().timeIntervalSince(t0) * 1000)

      var faces: [[String: Any]] = []
      for obs in (request.results ?? []) {
        var face: [String: Any] = [
          "box": flipBox(obs.boundingBox),
          "confidence": obs.confidence,
        ]
        if let lm = obs.landmarks {
          var regions: [String: [[String: CGFloat]]] = [:]
          let namedRegions: [(String, VNFaceLandmarkRegion2D?)] = [
            ("faceContour", lm.faceContour),
            ("leftEye", lm.leftEye),
            ("rightEye", lm.rightEye),
            ("leftEyebrow", lm.leftEyebrow),
            ("rightEyebrow", lm.rightEyebrow),
            ("nose", lm.nose),
            ("noseCrest", lm.noseCrest),
            ("medianLine", lm.medianLine),
            ("outerLips", lm.outerLips),
            ("innerLips", lm.innerLips),
            ("leftPupil", lm.leftPupil),
            ("rightPupil", lm.rightPupil),
          ]
          for (name, region) in namedRegions {
            guard let region = region else { continue }
            let box = obs.boundingBox
            var points: [[String: CGFloat]] = []
            for i in 0..<region.pointCount {
              let pt = region.normalizedPoints[i]
              // Region points are relative to the face bounding box; convert to image coords.
              let imgX = box.origin.x + pt.x * box.width
              let imgY = 1.0 - (box.origin.y + pt.y * box.height)
              points.append(["x": imgX, "y": imgY])
            }
            regions[name] = points
          }
          face["landmarks"] = regions
        }
        faces.append(face)
      }

      return [
        "width": image.width,
        "height": image.height,
        "elapsedMs": elapsedMs,
        "faces": faces,
      ]
    }

    // --- Person Segmentation ---
    AsyncFunction("detectPersonSegmentation") { (uri: String) -> [String: Any] in
      guard let image = loadCGImage(uri: uri) else {
        throw VisionDetectError.imageLoadFailed
      }
      let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
      let request = VNGeneratePersonSegmentationRequest()
      request.qualityLevel = .balanced

      let t0 = Date()
      try handler.perform([request])
      let elapsedMs = Int(Date().timeIntervalSince(t0) * 1000)

      guard let result = request.results?.first else {
        return [
          "width": image.width,
          "height": image.height,
          "elapsedMs": elapsedMs,
          "maskBase64": "",
          "maskWidth": 0,
          "maskHeight": 0,
        ]
      }

      let maskBuffer = result.pixelBuffer
      let maskW = CVPixelBufferGetWidth(maskBuffer)
      let maskH = CVPixelBufferGetHeight(maskBuffer)

      // Convert the mask pixel buffer to a PNG base64 string
      let ciImage = CIImage(cvPixelBuffer: maskBuffer)
      let ciCtx = CIContext()
      var maskBase64 = ""
      if let cgMask = ciCtx.createCGImage(ciImage, from: ciImage.extent) {
        let uiMask = UIImage(cgImage: cgMask)
        if let pngData = uiMask.pngData() {
          maskBase64 = pngData.base64EncodedString()
        }
      }

      return [
        "width": image.width,
        "height": image.height,
        "elapsedMs": elapsedMs,
        "maskBase64": maskBase64,
        "maskWidth": maskW,
        "maskHeight": maskH,
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
