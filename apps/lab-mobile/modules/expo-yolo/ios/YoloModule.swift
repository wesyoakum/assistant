import ExpoModulesCore
import Vision
import CoreML
import UIKit
import AudioToolbox
import AVFoundation
import CoreImage

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

    Events("onDetection")

    Function("isReady") { () -> Bool in
      return self.visionModel != nil
    }

    Function("loadError") { () -> String? in
      return self.loadError
    }

    Function("currentModel") { () -> String in
      return self.currentModelName
    }

    // List available models (bundled + downloaded).
    Function("availableModels") { () -> [String] in
      return self.listAllModels()
    }

    // Switch to a different model at runtime.
    AsyncFunction("switchModel") { (name: String) -> Bool in
      self.loadModel(name: name)
      return self.visionModel != nil
    }

    // Download a .mlmodel from a URL, compile it, and save to documents.
    // Returns the model name on success.
    AsyncFunction("downloadModel") { (urlString: String, name: String) -> String in
      guard let url = URL(string: urlString) else {
        throw YoloError.notReady("Invalid URL")
      }
      let (data, _) = try await URLSession.shared.data(from: url)
      // Write to temp .mlmodel file.
      let tempFile = FileManager.default.temporaryDirectory.appendingPathComponent("\(name).mlmodel")
      try data.write(to: tempFile)
      // Compile the model.
      let compiledURL = try MLModel.compileModel(at: tempFile)
      // Move compiled model to our models directory.
      let destURL = self.modelsDir.appendingPathComponent("\(name).mlmodelc")
      if FileManager.default.fileExists(atPath: destURL.path) {
        try FileManager.default.removeItem(at: destURL)
      }
      try FileManager.default.moveItem(at: compiledURL, to: destURL)
      try? FileManager.default.removeItem(at: tempFile)
      return name
    }

    // Import a .mlmodel from a local file URI, compile it, save to documents.
    AsyncFunction("importModel") { (fileUri: String, name: String) -> String in
      guard let url = URL(string: fileUri) ?? URL(fileURLWithPath: fileUri) as URL? else {
        throw YoloError.notReady("Invalid file URI")
      }
      let compiledURL = try MLModel.compileModel(at: url)
      let destURL = self.modelsDir.appendingPathComponent("\(name).mlmodelc")
      if FileManager.default.fileExists(atPath: destURL.path) {
        try FileManager.default.removeItem(at: destURL)
      }
      try FileManager.default.moveItem(at: compiledURL, to: destURL)
      return name
    }

    // Delete a downloaded model.
    Function("deleteModel") { (name: String) -> Bool in
      let path = self.modelsDir.appendingPathComponent("\(name).mlmodelc")
      try? FileManager.default.removeItem(at: path)
      return true
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

    // Run YOLO detection on every frame of a video in a single native pass.
    // Eliminates per-frame JPEG encode/decode and JS bridge round-trips.
    AsyncFunction("detectInVideo") { (uri: String, opts: [String: Any]) -> [String: Any] in
      guard let vModel = self.visionModel else {
        throw YoloError.notReady(self.loadError ?? "model not loaded")
      }
      guard let url = resolveVideoURL(uri) else {
        throw YoloError.notReady("Could not resolve video URI")
      }

      let startTimeSec = opts["startTimeSec"] as? Double ?? 0
      let endTimeSec = opts["endTimeSec"] as? Double ?? Double.greatestFiniteMagnitude
      let stepSec = opts["stepSec"] as? Double ?? (1.0 / 30.0)
      let maxFrames = opts["maxFrames"] as? Int ?? 0
      let maxMisses = opts["maxMisses"] as? Int ?? Int.max
      let minConfidence = (opts["minConfidence"] as? Double).map { Float($0) } ?? 0.25
      let labelFilter: Set<String>? = (opts["labelFilter"] as? [String]).map { Set($0) }
      let realTime = opts["realTime"] as? Bool ?? false

      // Parse optional preprocessing (grayscale + contrast).
      var doPreprocess = false
      var contrastLevel: Double = 1.0
      if let prep = opts["preprocess"] as? [String: Any] {
        doPreprocess = prep["grayscale"] as? Bool ?? false
        contrastLevel = prep["contrast"] as? Double ?? 1.0
      }

      // Open video and detect rotation.
      let asset = AVURLAsset(url: url)
      guard let videoTrack = asset.tracks(withMediaType: .video).first else {
        throw YoloError.notReady("No video track found")
      }
      let fps = Double(videoTrack.nominalFrameRate)
      let rawSize = videoTrack.naturalSize
      let xform = videoTrack.preferredTransform
      let transformed = rawSize.applying(xform)
      let displayWidth = Int(abs(transformed.width))
      let displayHeight = Int(abs(transformed.height))
      let rotationAngle = atan2(xform.b, xform.a) // 0, π/2, π, -π/2
      let durationSec = CMTimeGetSeconds(asset.duration)
      let effectiveEnd = min(endTimeSec, durationSec)

      // Parse optional ROI. JS sends display-space (top-left normalized).
      // Store display-space ROI for remapping detection results.
      var roiRect: CGRect? = nil
      var roiDisplay: (x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat)? = nil
      if let roi = opts["roi"] as? [String: Any],
         let rx = (roi["x"] as? Double).map({ CGFloat($0) }),
         let ry = (roi["y"] as? Double).map({ CGFloat($0) }),
         let rw = (roi["width"] as? Double).map({ CGFloat($0) }),
         let rh = (roi["height"] as? Double).map({ CGFloat($0) }) {
        roiDisplay = (x: rx, y: ry, w: rw, h: rh)
        var cx: CGFloat, cy: CGFloat, cw: CGFloat, ch: CGFloat
        let pi = Double.pi
        if abs(rotationAngle - pi / 2) < 0.01 {
          cx = ry; cy = 1 - rx - rw; cw = rh; ch = rw
        } else if abs(rotationAngle + pi / 2) < 0.01 {
          cx = 1 - ry - rh; cy = rx; cw = rh; ch = rw
        } else if abs(abs(rotationAngle) - pi) < 0.01 {
          cx = 1 - rx - rw; cy = 1 - ry - rh; cw = rw; ch = rh
        } else {
          cx = rx; cy = ry; cw = rw; ch = rh
        }
        cx = max(0, min(1 - 0.001, cx))
        cy = max(0, min(1 - 0.001, cy))
        cw = max(0.001, min(1 - cx, cw))
        ch = max(0.001, min(1 - cy, ch))
        roiRect = CGRect(x: cx, y: 1.0 - cy - ch, width: cw, height: ch)
      }

      // Set up AVAssetReader.
      let cmStart = CMTime(seconds: max(0, startTimeSec), preferredTimescale: 600)
      let cmEnd = CMTime(seconds: effectiveEnd, preferredTimescale: 600)
      let reader = try AVAssetReader(asset: asset)
      reader.timeRange = CMTimeRange(start: cmStart, end: cmEnd)

      let outputSettings: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA)
      ]
      let trackOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: outputSettings)
      trackOutput.alwaysCopiesSampleData = false
      guard reader.canAdd(trackOutput) else {
        throw YoloError.notReady("Cannot add track output to reader")
      }
      reader.add(trackOutput)
      guard reader.startReading() else {
        throw YoloError.notReady("AVAssetReader failed to start: \(reader.error?.localizedDescription ?? "unknown")")
      }

      let sampleStride = max(1, Int(round(stepSec * fps)))
      let ciContext = doPreprocess ? CIContext() : nil
      let t0 = Date()
      var results: [[String: Any]] = []
      var rawIndex = -1
      var outputIndex = 0
      var misses = 0

      while let sampleBuffer = trackOutput.copyNextSampleBuffer() {
        rawIndex += 1
        if sampleStride > 1 && rawIndex % sampleStride != 0 { continue }
        if maxFrames > 0 && outputIndex >= maxFrames { break }

        let timeSec = startTimeSec + Double(outputIndex) * stepSec

        autoreleasepool {
          guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            let entry: [String: Any] = [
              "frameIndex": outputIndex, "timeSec": timeSec,
              "box": NSNull(), "confidence": 0.0, "lost": true,
            ]
            results.append(entry)
            self.sendEvent("onDetection", entry)
            misses += 1
            outputIndex += 1
            return
          }

          // Build the image handler — either preprocessed or raw.
          let handler: VNImageRequestHandler
          if doPreprocess, let ctx = ciContext {
            var ciImage = CIImage(cvPixelBuffer: pixelBuffer)
            let filter = CIFilter(name: "CIColorControls")!
            filter.setValue(ciImage, forKey: kCIInputImageKey)
            filter.setValue(NSNumber(value: 0.0), forKey: kCIInputSaturationKey)
            filter.setValue(NSNumber(value: contrastLevel), forKey: kCIInputContrastKey)
            if let output = filter.outputImage {
              ciImage = output
            }
            handler = VNImageRequestHandler(ciImage: ciImage, orientation: .up, options: [:])
          } else {
            handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up, options: [:])
          }

          // Run inference.
          let request = VNCoreMLRequest(model: vModel)
          request.imageCropAndScaleOption = .scaleFit
          if let roi = roiRect {
            request.regionOfInterest = roi
          }

          do {
            try handler.perform([request])
          } catch {
            let entry: [String: Any] = [
              "frameIndex": outputIndex, "timeSec": timeSec,
              "box": NSNull(), "confidence": 0.0, "lost": true,
            ]
            results.append(entry)
            self.sendEvent("onDetection", entry)
            misses += 1
            outputIndex += 1
            return
          }

          // Pick best detection: highest confidence, smallest area on tie.
          let observations = (request.results ?? []).compactMap { $0 as? VNRecognizedObjectObservation }
          let candidates = observations.filter { obs in
            guard let top = obs.labels.first, top.confidence >= minConfidence else { return false }
            if let filter = labelFilter { return filter.contains(top.identifier) }
            return true
          }

          let entry: [String: Any]
          if let best = candidates.sorted(by: { a, b in
            let confA = a.labels.first!.confidence
            let confB = b.labels.first!.confidence
            if abs(confB - confA) > 1e-3 { return confA > confB }
            let areaA = a.boundingBox.width * a.boundingBox.height
            let areaB = b.boundingBox.width * b.boundingBox.height
            return areaA < areaB
          }).first {
            misses = 0
            entry = [
              "frameIndex": outputIndex, "timeSec": timeSec,
              "box": remapToFullFrame(rotateBox(flipBox(best.boundingBox), angle: rotationAngle), roi: roiDisplay),
              "confidence": Double(best.labels.first!.confidence),
              "lost": false,
            ]
          } else {
            misses += 1
            entry = [
              "frameIndex": outputIndex, "timeSec": timeSec,
              "box": NSNull(), "confidence": 0.0, "lost": true,
            ]
          }
          results.append(entry)
          self.sendEvent("onDetection", entry)

          // Real-time pacing: sleep to match video frame rate.
          if realTime {
            let elapsed = Date().timeIntervalSince(t0) - Double(outputIndex) * stepSec
            let target = Double(outputIndex + 1) * stepSec
            let sleepTime = target - Date().timeIntervalSince(t0)
            if sleepTime > 0 {
              Thread.sleep(forTimeInterval: sleepTime)
            }
          }

          outputIndex += 1
        } // autoreleasepool

        if misses >= maxMisses { break }
      }

      reader.cancelReading()

      return [
        "frames": results,
        "videoWidth": displayWidth,
        "videoHeight": displayHeight,
        "frameRate": fps,
        "elapsedMs": Int(Date().timeIntervalSince(t0) * 1000),
      ]
    }
  }

  /// Directory for downloaded/imported models.
  private var modelsDir: URL {
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let dir = docs.appendingPathComponent("yolo-models", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  private func loadModel(name: String) {
    self.loadError = nil
    self.visionModel = nil
    self.currentModelName = ""
    do {
      // Search: 1) documents dir, 2) app bundle, 3) resource bundle.
      let candidates: [URL?] = [
        modelsDir.appendingPathComponent("\(name).mlmodelc"),
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
      let existing = candidates.compactMap { $0 }.filter { FileManager.default.fileExists(atPath: $0.path) }
      guard let modelURL = existing.first else {
        self.loadError = "\(name) not found (bundle or downloads)"
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

  /// List models in both the bundle and the documents directory.
  private func listAllModels() -> [String] {
    var models: [String] = []
    // Bundle models.
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
    // Downloaded models.
    if let contents = try? FileManager.default.contentsOfDirectory(at: modelsDir, includingPropertiesForKeys: nil) {
      for url in contents where url.pathExtension == "mlmodelc" {
        let name = url.deletingPathExtension().lastPathComponent
        if !models.contains(name) { models.append(name) }
      }
    }
    return models.sorted()
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

/// Remap ROI-relative detection coordinates to full-frame display space.
/// Vision's regionOfInterest returns coords relative to the ROI crop, not full-frame.
private func remapToFullFrame(_ box: [String: CGFloat], roi: (x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat)?) -> [String: CGFloat] {
  guard let roi = roi else { return box }
  return [
    "x": roi.x + box["x"]! * roi.w,
    "y": roi.y + box["y"]! * roi.h,
    "width": box["width"]! * roi.w,
    "height": box["height"]! * roi.h,
  ]
}

/// Remap a normalized top-left-origin box from codec space to display space
/// based on the video track's rotation angle (radians).
private func rotateBox(_ box: [String: CGFloat], angle: Double) -> [String: CGFloat] {
  let x = box["x"]!, y = box["y"]!, w = box["width"]!, h = box["height"]!
  let pi = Double.pi
  if abs(angle - pi / 2) < 0.01 {
    // 90° CW (portrait, most common)
    return ["x": 1 - y - h, "y": x, "width": h, "height": w]
  } else if abs(angle + pi / 2) < 0.01 {
    // 90° CCW (270° CW)
    return ["x": y, "y": 1 - x - w, "width": h, "height": w]
  } else if abs(abs(angle) - pi) < 0.01 {
    // 180°
    return ["x": 1 - x - w, "y": 1 - y - h, "width": w, "height": h]
  }
  // 0° — no rotation
  return box
}

private func resolveVideoURL(_ uri: String) -> URL? {
  if uri.hasPrefix("file://") { return URL(string: uri) }
  if uri.hasPrefix("/") { return URL(fileURLWithPath: uri) }
  return URL(string: uri)
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
