import ExpoModulesCore
import AVFoundation
import CoreMedia
import CoreVideo
import UIKit

/// Template-matching video tracker.
///
/// Algorithm per frame:
///   1. Predict next-frame target center from prior velocity (linear).
///   2. Define a search window around the prediction, sized as a multiple of
///      the (rescaled) template.
///   3. Compute normalized cross-correlation (NCC) at each candidate offset.
///   4. Peak NCC → new position. Confidence = NCC score, clamped to [0, 1].
///   5. Update velocity from the new position; loop.
///
/// We work on the luma channel of each BGRA frame (no colour). Templates are
/// extracted from the first frame's box; for v1, the template is fixed at the
/// initial scale (no per-frame rescaling — to be added when callers can
/// estimate the target's pixel-size trajectory).
public final class TemplateTrackerModule: Module {

  public func definition() -> ModuleDefinition {
    Name("ExpoTemplateTracker")

    // Track a single target through the video, starting from the user-drawn
    // box on the frame at `startTimeSec`.
    //
    // opts:
    //   sampleStride: process every Nth frame (1 = every frame, default).
    //   maxFrames: hard cap (0 = no cap).
    //   startTimeSec: skip the asset reader to this video timestamp.
    //   confidenceCutoff: stop after 8 consecutive frames below this NCC.
    //   searchPadding: search-window radius as a multiplier of the template
    //                  half-dimension. 3 → window is 7× the template size.
    //   downsample: integer luma downsample (1 = native, 2 = half each axis,
    //               4 = quarter). 2 is a good default for speed.
    AsyncFunction("trackInVideo") { (uri: String, initialBox: [String: Double], opts: [String: Any]) -> [String: Any] in
      guard let url = resolveURL(uri) else { throw NSError.tt("Could not resolve video URI") }

      let sampleStride = max(1, (opts["sampleStride"] as? Int) ?? 1)
      let maxFrames = (opts["maxFrames"] as? Int) ?? 0
      let startTimeSec = (opts["startTimeSec"] as? Double) ?? 0
      let cutoff = Float((opts["confidenceCutoff"] as? Double) ?? 0.30)
      let searchPadding = max(1, (opts["searchPadding"] as? Int) ?? 3)
      let downsample = max(1, (opts["downsample"] as? Int) ?? 2)

      let asset = AVURLAsset(url: url)
      guard let track = asset.tracks(withMediaType: .video).first else {
        throw NSError.tt("Video has no video track")
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
        throw NSError.tt("AVAssetReader could not start (\(reader.error?.localizedDescription ?? "unknown"))")
      }

      let frameRate = Double(track.nominalFrameRate)
      let videoWidth = Int(track.naturalSize.width)
      let videoHeight = Int(track.naturalSize.height)

      // The JS UI uses top-left normalized coords. Convert the initial box to
      // pixel coords against the downsampled image.
      let initBoxNorm = CGRect(
        x: initialBox["x"] ?? 0,
        y: initialBox["y"] ?? 0,
        width: initialBox["width"] ?? 0,
        height: initialBox["height"] ?? 0
      )

      // State.
      var template: [Float] = []
      var templateW: Int = 0
      var templateH: Int = 0
      var templateMean: Float = 0
      var templateNorm: Float = 0  // sqrt(sum((T-mean)^2))

      var prevCenter: (x: Int, y: Int)? = nil
      var prevPrevCenter: (x: Int, y: Int)? = nil
      var lowStreak = 0

      var results: [[String: Any]] = []
      var frameIndex = -1
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

        // Pull luma plane (downsampled) from the BGRA frame.
        guard let luma = bgraToLuma(pb, downsample: downsample) else {
          CMSampleBufferInvalidate(sample)
          continue
        }
        let lumaW = luma.width
        let lumaH = luma.height

        if frameIndex == 0 {
          // Crop the template from this frame's box. We tighten the crop to
          // the central templateInset of the user-drawn rect so the template
          // is dominated by the actual target rather than the surrounding
          // background (which would otherwise let NCC lock onto the local
          // pitcher / hand region instead of the ball flying away).
          let bxRaw = max(0, min(lumaW - 2, Int(initBoxNorm.minX * CGFloat(lumaW))))
          let byRaw = max(0, min(lumaH - 2, Int(initBoxNorm.minY * CGFloat(lumaH))))
          let bwRaw = max(2, min(lumaW - bxRaw, Int(initBoxNorm.width * CGFloat(lumaW))))
          let bhRaw = max(2, min(lumaH - byRaw, Int(initBoxNorm.height * CGFloat(lumaH))))
          let insetX = max(0, bwRaw / 6)  // chop 1/6 off each side → keep central ~67%
          let insetY = max(0, bhRaw / 6)
          let bx = bxRaw + insetX
          let by = byRaw + insetY
          let bw = max(2, bwRaw - 2 * insetX)
          let bh = max(2, bhRaw - 2 * insetY)
          templateW = bw
          templateH = bh
          template = Array(repeating: 0, count: bw * bh)
          for y in 0..<bh {
            for x in 0..<bw {
              template[y * bw + x] = luma.data[(by + y) * lumaW + (bx + x)]
            }
          }
          // Template mean + norm.
          var s: Float = 0
          for v in template { s += v }
          templateMean = s / Float(bw * bh)
          var n: Float = 0
          for v in template { let d = v - templateMean; n += d * d }
          templateNorm = sqrt(n)

          let cx = bx + bw / 2
          let cy = by + bh / 2
          prevCenter = (cx, cy)

          results.append([
            "frameIndex": frameIndex,
            "timeSec": timeSec,
            "box": [
              "x": Double(bx) / Double(lumaW),
              "y": Double(by) / Double(lumaH),
              "width": Double(bw) / Double(lumaW),
              "height": Double(bh) / Double(lumaH),
            ],
            "confidence": 1.0,
            "lost": false,
          ])
          CMSampleBufferInvalidate(sample)
          if maxFrames > 0 && results.count >= maxFrames { break }
          continue
        }

        // ── Predict ─────────────────────────────────────────────────
        let pc = prevCenter!
        let predicted: (x: Int, y: Int) = {
          if let ppc = prevPrevCenter {
            return (pc.x + (pc.x - ppc.x), pc.y + (pc.y - ppc.y))
          }
          return pc
        }()

        // Search window centered on prediction.
        // Minimum window: scaled to the image, never less than ~6.5% of width.
        // First non-template frame has no velocity yet — use a much wider
        // window so we can still catch a fast-moving target.
        let halfW = templateW / 2
        let halfH = templateH / 2
        let scaledMin = max(40, lumaW / 15)
        let firstNonTemplate = (prevPrevCenter == nil)
        let radBase = searchPadding * max(halfW, halfH, 4)
        let radPredFrames = firstNonTemplate ? max(scaledMin * 3, radBase) : max(scaledMin, radBase)
        let radX = radPredFrames
        let radY = radPredFrames
        // The top-left of the template patch can range from minX to maxX inclusive.
        let minX = max(0, predicted.x - halfW - radX)
        let maxX = min(lumaW - templateW, predicted.x - halfW + radX)
        let minY = max(0, predicted.y - halfH - radY)
        let maxY = min(lumaH - templateH, predicted.y - halfH + radY)

        var bestScore: Float = -Float.infinity
        var bestX = predicted.x - halfW
        var bestY = predicted.y - halfH

        // Skip stride during NCC — search every pixel (cheap because window is small).
        if maxX >= minX && maxY >= minY {
          let stride = 1
          var y = minY
          while y <= maxY {
            var x = minX
            while x <= maxX {
              let score = ncc(
                template: template, templateW: templateW, templateH: templateH,
                templateMean: templateMean, templateNorm: templateNorm,
                image: luma.data, imageW: lumaW, imageH: lumaH,
                atX: x, atY: y
              )
              if score > bestScore {
                bestScore = score
                bestX = x
                bestY = y
              }
              x += stride
            }
            y += stride
          }
        }

        let conf = max(0.0, min(1.0, Double(bestScore)))
        let lost = Float(conf) < cutoff
        if lost { lowStreak += 1 } else { lowStreak = 0 }

        prevPrevCenter = prevCenter
        prevCenter = (bestX + templateW / 2, bestY + templateH / 2)

        results.append([
          "frameIndex": frameIndex,
          "timeSec": timeSec,
          "box": [
            "x": Double(bestX) / Double(lumaW),
            "y": Double(bestY) / Double(lumaH),
            "width": Double(templateW) / Double(lumaW),
            "height": Double(templateH) / Double(lumaH),
          ],
          "confidence": conf,
          "lost": lost,
        ])

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

private extension NSError {
  static func tt(_ msg: String) -> NSError {
    NSError(domain: "ExpoTemplateTracker", code: -1, userInfo: [NSLocalizedDescriptionKey: msg])
  }
}

private func resolveURL(_ uri: String) -> URL? {
  if uri.hasPrefix("file://") { return URL(string: uri) }
  if uri.hasPrefix("ph://") || uri.hasPrefix("assets-library://") { return nil }
  if uri.hasPrefix("/") { return URL(fileURLWithPath: uri) }
  return URL(string: uri)
}

// MARK: - Luma extraction

private struct LumaFrame {
  let data: [Float]
  let width: Int
  let height: Int
}

private func bgraToLuma(_ pb: CVPixelBuffer, downsample: Int) -> LumaFrame? {
  CVPixelBufferLockBaseAddress(pb, .readOnly)
  defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
  let srcW = CVPixelBufferGetWidth(pb)
  let srcH = CVPixelBufferGetHeight(pb)
  let bytesPerRow = CVPixelBufferGetBytesPerRow(pb)
  guard let base = CVPixelBufferGetBaseAddress(pb) else { return nil }
  let ptr = base.assumingMemoryBound(to: UInt8.self)

  let dW = max(2, srcW / downsample)
  let dH = max(2, srcH / downsample)
  var out = [Float](repeating: 0, count: dW * dH)

  // BGRA byte ordering. Y' = 0.114*B + 0.587*G + 0.299*R.
  for y in 0..<dH {
    let srcY = y * downsample
    let rowStart = srcY * bytesPerRow
    for x in 0..<dW {
      let srcX = x * downsample
      let i = rowStart + srcX * 4
      let b = Float(ptr[i])
      let g = Float(ptr[i + 1])
      let r = Float(ptr[i + 2])
      out[y * dW + x] = 0.114 * b + 0.587 * g + 0.299 * r
    }
  }
  return LumaFrame(data: out, width: dW, height: dH)
}

// MARK: - NCC

@inline(__always)
private func ncc(
  template: [Float], templateW: Int, templateH: Int,
  templateMean: Float, templateNorm: Float,
  image: [Float], imageW: Int, imageH: Int,
  atX: Int, atY: Int
) -> Float {
  // Bounds (caller is responsible, but guard).
  if atX < 0 || atY < 0 || atX + templateW > imageW || atY + templateH > imageH {
    return -Float.infinity
  }
  let n = templateW * templateH
  // Image patch mean.
  var sum: Float = 0
  for y in 0..<templateH {
    let row = (atY + y) * imageW + atX
    var x = 0
    while x < templateW {
      sum += image[row + x]
      x += 1
    }
  }
  let imageMean = sum / Float(n)

  // Numerator + image-patch norm.
  var num: Float = 0
  var imgNorm: Float = 0
  for y in 0..<templateH {
    let row = (atY + y) * imageW + atX
    let trow = y * templateW
    for x in 0..<templateW {
      let i = image[row + x] - imageMean
      let t = template[trow + x] - templateMean
      num += i * t
      imgNorm += i * i
    }
  }
  let denom = sqrt(imgNorm) * templateNorm
  if denom <= 0 { return 0 }
  return num / denom
}
