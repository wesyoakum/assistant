import ExpoModulesCore
import AVFoundation
import CoreMedia
import CoreVideo
import CoreML
import CoreImage
import Accelerate
import UIKit

/// TrackNet video ball tracker.
///
/// The bundled CoreML model takes 3 consecutive RGB frames (concatenated as
/// a 9-channel tensor) at 360×640 and outputs a heatmap of where the ball
/// is in the current (latest) frame. The argmax of the heatmap is the ball
/// pixel; the value at that pixel is treated as confidence.
///
/// Algorithm per frame:
///   1. Decode frame i from the video, resize → 640×360 RGB.
///   2. Append to a sliding window. First frame: pad by duplicating itself
///      so we always have 3 frames to feed.
///   3. Build a (1, 9, 360, 640) float tensor, normalize to [0, 1], NCHW.
///   4. Run the model.
///   5. Find the heatmap peak → ball pixel. Report a small fixed-size box
///      around the peak.
public final class TrackNetModule: Module {
  private var model: MLModel?
  private var loadError: String?

  // TrackNet input shape (per the converted model spec).
  private let TN_W = 640
  private let TN_H = 360
  private let TN_CH = 9   // 3 frames × 3 channels
  // The visualised box we report around the heatmap peak (in pixels of the
  // 640×360 model input space — then normalised against video dimensions).
  private let BOX_PX = 22.0

  public func definition() -> ModuleDefinition {
    Name("ExpoTrackNet")

    OnCreate {
      do {
        let candidates: [URL?] = [
          Bundle.main.url(forResource: "TrackNet", withExtension: "mlmodelc"),
          Bundle.main.url(forResource: "TrackNet", withExtension: "mlmodelc", subdirectory: "ExpoTrackNetModel.bundle"),
          {
            if let bundleURL = Bundle.main.url(forResource: "ExpoTrackNetModel", withExtension: "bundle"),
               let b = Bundle(url: bundleURL) {
              return b.url(forResource: "TrackNet", withExtension: "mlmodelc")
            }
            return nil
          }(),
        ]
        guard let modelURL = candidates.compactMap({ $0 }).first else {
          self.loadError = "TrackNet.mlmodelc not found in app bundle"
          return
        }
        let cfg = MLModelConfiguration()
        cfg.computeUnits = .all
        self.model = try MLModel(contentsOf: modelURL, configuration: cfg)
      } catch {
        self.loadError = "Model load failed: \(error.localizedDescription)"
      }
    }

    Function("isReady") { () -> Bool in
      return self.model != nil
    }

    Function("loadError") { () -> String? in
      return self.loadError
    }

    AsyncFunction("trackInVideo") { (uri: String, opts: [String: Any]) -> [String: Any] in
      guard let model = self.model else { throw TNError.notReady(self.loadError ?? "model not loaded") }
      guard let url = resolveURL(uri) else { throw TNError.tn("Could not resolve video URI") }

      let sampleStride = max(1, (opts["sampleStride"] as? Int) ?? 1)
      let maxFrames = (opts["maxFrames"] as? Int) ?? 0
      let startTimeSec = (opts["startTimeSec"] as? Double) ?? 0
      let cutoff = Float((opts["confidenceCutoff"] as? Double) ?? 0.10)

      let asset = AVURLAsset(url: url)
      guard let track = asset.tracks(withMediaType: .video).first else {
        throw TNError.tn("Video has no video track")
      }

      let reader = try AVAssetReader(asset: asset)
      if startTimeSec > 0 {
        let cmStart = CMTime(seconds: startTimeSec, preferredTimescale: 600)
        let remaining = CMTimeSubtract(asset.duration, cmStart)
        if CMTimeCompare(remaining, .zero) > 0 {
          reader.timeRange = CMTimeRange(start: cmStart, duration: remaining)
        }
      }
      let outputSettings: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA)
      ]
      let output = AVAssetReaderTrackOutput(track: track, outputSettings: outputSettings)
      output.alwaysCopiesSampleData = false
      reader.add(output)
      guard reader.startReading() else {
        throw TNError.tn("AVAssetReader could not start (\(reader.error?.localizedDescription ?? "unknown"))")
      }

      let frameRate = Double(track.nominalFrameRate)
      let videoWidth = Int(track.naturalSize.width)
      let videoHeight = Int(track.naturalSize.height)

      // Pre-allocate scratch buffers.
      let pixelCount = self.TN_W * self.TN_H
      var fPrev2 = [Float](repeating: 0, count: pixelCount * 3)
      var fPrev1 = [Float](repeating: 0, count: pixelCount * 3)
      var fCur   = [Float](repeating: 0, count: pixelCount * 3)
      var haveTwo = false
      var haveOne = false

      // CI context for resize/format conversion.
      let ciContext = CIContext(options: [.workingColorSpace: NSNull()])

      // The model's MultiArray input.
      let arr = try MLMultiArray(shape: [1, NSNumber(value: self.TN_CH), NSNumber(value: self.TN_H), NSNumber(value: self.TN_W)], dataType: .float32)
      let arrPtr = arr.dataPointer.assumingMemoryBound(to: Float32.self)

      var results: [[String: Any]] = []
      var frameIndex = -1
      var lowStreak = 0
      let started = Date()

      while let sample = output.copyNextSampleBuffer() {
        frameIndex += 1
        if sampleStride > 1, frameIndex % sampleStride != 0 {
          CMSampleBufferInvalidate(sample)
          continue
        }
        guard let pb = CMSampleBufferGetImageBuffer(sample) else { continue }
        let time = CMSampleBufferGetPresentationTimeStamp(sample)
        let timeSec = CMTimeGetSeconds(time)

        // Resize current frame into fCur (R, G, B planes contiguous in [0,1]).
        if !writeResizedRGBFloats(pb: pb, out: &fCur, ciContext: ciContext, dstW: self.TN_W, dstH: self.TN_H) {
          CMSampleBufferInvalidate(sample)
          continue
        }

        // Window-pad: at start, duplicate the current frame.
        if !haveOne { fPrev1 = fCur; haveOne = true }
        if !haveTwo { fPrev2 = fPrev1; haveTwo = true }

        // Build the input tensor [1, 9, 360, 640] = NCHW, channel order:
        // R_{t-2}, G_{t-2}, B_{t-2}, R_{t-1}, G_{t-1}, B_{t-1}, R_t, G_t, B_t
        // Each Frame's planes (fX) are already in plane-major: R then G then B,
        // each plane = TN_H * TN_W floats.
        memcpy(arrPtr,                          fPrev2, pixelCount * 3 * MemoryLayout<Float32>.size)
        memcpy(arrPtr.advanced(by: pixelCount * 3), fPrev1, pixelCount * 3 * MemoryLayout<Float32>.size)
        memcpy(arrPtr.advanced(by: pixelCount * 6), fCur,   pixelCount * 3 * MemoryLayout<Float32>.size)

        // Run inference.
        let provider = try MLDictionaryFeatureProvider(dictionary: ["frames": MLFeatureValue(multiArray: arr)])
        let outFeats: MLFeatureProvider
        do {
          outFeats = try model.prediction(from: provider)
        } catch {
          results.append([
            "frameIndex": frameIndex,
            "timeSec": timeSec,
            "box": NSNull(),
            "confidence": 0.0,
            "lost": true,
            "error": "\(error.localizedDescription)",
          ])
          CMSampleBufferInvalidate(sample)
          break
        }
        guard let heatmap = outFeats.featureValue(for: "heatmap")?.multiArrayValue else {
          // Try first feature if the name differs.
          var found: MLMultiArray? = nil
          for name in outFeats.featureNames {
            if let v = outFeats.featureValue(for: name)?.multiArrayValue { found = v; break }
          }
          guard let hm = found else {
            CMSampleBufferInvalidate(sample)
            break
          }
          // Treat hm as heatmap below.
          let (px, py, peak) = argmaxHeatmap(hm)
          appendResult(into: &results, frameIndex: frameIndex, timeSec: timeSec, px: px, py: py, peak: peak,
                       videoW: videoWidth, videoH: videoHeight, modelW: self.TN_W, modelH: self.TN_H, boxPx: self.BOX_PX)
          CMSampleBufferInvalidate(sample)
          // Shift sliding window.
          fPrev2 = fPrev1
          fPrev1 = fCur
          continue
        }
        let (px, py, peak) = argmaxHeatmap(heatmap)
        appendResult(into: &results, frameIndex: frameIndex, timeSec: timeSec, px: px, py: py, peak: peak,
                     videoW: videoWidth, videoH: videoHeight, modelW: self.TN_W, modelH: self.TN_H, boxPx: self.BOX_PX)

        // Update window for next iteration.
        fPrev2 = fPrev1
        fPrev1 = fCur

        // Track confidence streak.
        if Float(peak) < cutoff { lowStreak += 1 } else { lowStreak = 0 }

        CMSampleBufferInvalidate(sample)
        if lowStreak >= 8 { break }
        if maxFrames > 0 && results.count >= maxFrames { break }
      }

      let elapsedMs = Int(Date().timeIntervalSince(started) * 1000)
      return [
        "frames": results,
        "videoWidth": videoWidth,
        "videoHeight": videoHeight,
        "frameRate": frameRate,
        "elapsedMs": elapsedMs,
      ]
    }
  }
}

// MARK: - Helpers

enum TNError: Error, LocalizedError {
  case notReady(String)
  case tn(String)
  var errorDescription: String? {
    switch self {
    case .notReady(let m): return "TrackNet not ready: \(m)"
    case .tn(let m):       return m
    }
  }
}

private func resolveURL(_ uri: String) -> URL? {
  if uri.hasPrefix("file://") { return URL(string: uri) }
  if uri.hasPrefix("ph://") || uri.hasPrefix("assets-library://") { return nil }
  if uri.hasPrefix("/") { return URL(fileURLWithPath: uri) }
  return URL(string: uri)
}

/// Resize a BGRA CVPixelBuffer to (dstW × dstH) and write three planar
/// channels of normalized [0, 1] floats into `out` in order R, G, B
/// (out length must be dstW * dstH * 3).
private func writeResizedRGBFloats(pb: CVPixelBuffer, out: inout [Float], ciContext: CIContext, dstW: Int, dstH: Int) -> Bool {
  // Render the BGRA pixel buffer into a 32-bit RGBA bitmap of the target size.
  let ci = CIImage(cvPixelBuffer: pb)
  let srcW = ci.extent.width
  let srcH = ci.extent.height
  guard srcW > 0, srcH > 0 else { return false }
  let scaled = ci.transformed(by: CGAffineTransform(scaleX: CGFloat(dstW) / srcW, y: CGFloat(dstH) / srcH))
  let bytesPerRow = dstW * 4
  var rgba = [UInt8](repeating: 0, count: bytesPerRow * dstH)
  let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
  rgba.withUnsafeMutableBytes { raw in
    ciContext.render(scaled, toBitmap: raw.baseAddress!, rowBytes: bytesPerRow, bounds: CGRect(x: 0, y: 0, width: dstW, height: dstH), format: .RGBA8, colorSpace: colorSpace)
  }
  // Split into R, G, B float planes, [0, 1].
  let n = dstW * dstH
  for i in 0..<n {
    let r = Float(rgba[i * 4 + 0]) / 255.0
    let g = Float(rgba[i * 4 + 1]) / 255.0
    let b = Float(rgba[i * 4 + 2]) / 255.0
    out[i]         = r
    out[n + i]     = g
    out[2 * n + i] = b
  }
  return true
}

/// Find the (px, py, value) of the heatmap peak. Heatmap is (1, 1, H, W) or
/// (1, H, W) float32.
private func argmaxHeatmap(_ arr: MLMultiArray) -> (Int, Int, Double) {
  // Resolve H, W.
  let dims = arr.shape.map { $0.intValue }
  let h: Int, w: Int
  if dims.count == 4 { h = dims[2]; w = dims[3] }
  else if dims.count == 3 { h = dims[1]; w = dims[2] }
  else if dims.count == 2 { h = dims[0]; w = dims[1] }
  else { return (0, 0, 0) }

  let n = h * w
  var bestIdx = 0
  var bestVal: Float = -.infinity
  // Assume Float32 dataType (which our model produces).
  let ptr = arr.dataPointer.assumingMemoryBound(to: Float32.self)
  for i in 0..<n {
    let v = ptr[i]
    if v > bestVal { bestVal = v; bestIdx = i }
  }
  let py = bestIdx / w
  let px = bestIdx % w
  return (px, py, Double(bestVal))
}

private func appendResult(into results: inout [[String: Any]], frameIndex: Int, timeSec: Double, px: Int, py: Int, peak: Double, videoW: Int, videoH: Int, modelW: Int, modelH: Int, boxPx: Double) {
  // Peak position in model pixel space → normalised to video.
  let nx = Double(px) / Double(modelW)
  let ny = Double(py) / Double(modelH)
  // Box width in video-normalised coords: scale boxPx (in model space) up to the video,
  // then divide by video dims.
  let boxNW = (boxPx / Double(modelW))  // already normalised since model is normalised
  let boxNH = (boxPx / Double(modelH))
  let nbx = max(0, min(1 - boxNW, nx - boxNW / 2))
  let nby = max(0, min(1 - boxNH, ny - boxNH / 2))
  let conf = max(0.0, min(1.0, peak))
  results.append([
    "frameIndex": frameIndex,
    "timeSec": timeSec,
    "box": [
      "x": nbx,
      "y": nby,
      "width": boxNW,
      "height": boxNH,
    ],
    "confidence": conf,
    "lost": conf < 0.05,
  ])
  // Silence unused warnings if videoW/videoH end up irrelevant.
  _ = videoW; _ = videoH
}
