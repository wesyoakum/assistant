import ExpoModulesCore
import AVFoundation
import Vision
import CoreImage
import CoreMedia
import UIKit

public final class VisionTrackerModule: Module {

  public func definition() -> ModuleDefinition {
    Name("ExpoVisionTracker")

    // Returns a base64 JPEG of the first frame + its native pixel size.
    // The JS UI needs the still to let the user draw an initial bbox at full
    // resolution; the box gets passed back into trackInVideo().
    AsyncFunction("firstFrame") { (uri: String, jpegQuality: Double) -> [String: Any] in
      return try generateFrame(uri: uri, timeSec: 0, jpegQuality: jpegQuality)
    }

    // Returns a base64 JPEG of the frame at the given video timestamp.
    AsyncFunction("frameAtTime") { (uri: String, timeSec: Double, jpegQuality: Double) -> [String: Any] in
      return try generateFrame(uri: uri, timeSec: timeSec, jpegQuality: jpegQuality)
    }

    // Track a single object through the video, starting from the given box on
    // the first frame. Coordinates are top-left normalized [0,1] in image space.
    //
    // opts:
    //   maxFrames: hard cap on frames processed (0 = no cap)
    //   sampleStride: process every Nth frame (1 = every frame)
    //   confidenceCutoff: stop tracking once confidence < this for 5 frames
    //   startTimeSec: skip ahead to this video time before tracking (default 0)
    AsyncFunction("trackInVideo") { (uri: String, initialBox: [String: Double], opts: [String: Any]) -> [String: Any] in
      guard let url = resolveURL(uri) else { throw NSError.tracker("Could not resolve video URI") }

      let maxFrames = (opts["maxFrames"] as? Int) ?? 0
      let sampleStride = max(1, (opts["sampleStride"] as? Int) ?? 1)
      let cutoff = (opts["confidenceCutoff"] as? Double) ?? 0.05
      let startTimeSec = (opts["startTimeSec"] as? Double) ?? 0

      let asset = AVURLAsset(url: url)
      guard let track = asset.tracks(withMediaType: .video).first else {
        throw NSError.tracker("Video has no video track")
      }

      let reader = try AVAssetReader(asset: asset)
      // Skip the reader to the user's chosen start time.
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
        throw NSError.tracker("AVAssetReader could not start (\(reader.error?.localizedDescription ?? "unknown"))")
      }

      let frameRate = Double(track.nominalFrameRate)
      let videoWidth = Int(track.naturalSize.width)
      let videoHeight = Int(track.naturalSize.height)

      // VNTrackObjectRequest expects Vision-frame coords: origin bottom-left,
      // normalized [0,1], (x, y, w, h). The JS UI works in top-left
      // normalized coords — convert here.
      let topLeftBox = CGRect(
        x: initialBox["x"] ?? 0,
        y: initialBox["y"] ?? 0,
        width: initialBox["width"] ?? 0,
        height: initialBox["height"] ?? 0
      )
      let visionBox = flipYNormalized(topLeftBox)
      let initialObs = VNDetectedObjectObservation(boundingBox: visionBox)

      let request = VNTrackObjectRequest(detectedObjectObservation: initialObs)
      request.trackingLevel = .accurate

      let handler = VNSequenceRequestHandler()

      var results: [[String: Any]] = []
      var frameIndex = -1
      var lowConfStreak = 0
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

        if frameIndex == 0 {
          // The tracker doesn't actually do meaningful work for the very first
          // frame — we report the initial box back and prime the request.
          results.append([
            "frameIndex": frameIndex,
            "timeSec": timeSec,
            "box": topLeftBoxDict(topLeftBox),
            "confidence": 1.0,
            "lost": false,
          ])
          do {
            try handler.perform([request], on: pb)
          } catch {
            // Not fatal — continue with next frame using the same request.
          }
          CMSampleBufferInvalidate(sample)
          if maxFrames > 0 && results.count >= maxFrames { break }
          continue
        }

        // Run the tracker on this frame.
        do {
          try handler.perform([request], on: pb)
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

        guard let obs = request.results?.first as? VNDetectedObjectObservation else {
          results.append([
            "frameIndex": frameIndex,
            "timeSec": timeSec,
            "box": NSNull(),
            "confidence": 0.0,
            "lost": true,
          ])
          CMSampleBufferInvalidate(sample)
          break
        }

        // Push the updated observation back for the next iteration.
        let newRequest = VNTrackObjectRequest(detectedObjectObservation: obs)
        newRequest.trackingLevel = .accurate
        // VNTrackObjectRequest is a class; reset the existing one's input
        // observation via the new one — re-use the variable.
        request.inputObservation = obs

        let topLeft = flipYNormalized(obs.boundingBox)
        let conf = Double(obs.confidence)
        let lost = conf < cutoff
        if lost { lowConfStreak += 1 } else { lowConfStreak = 0 }

        results.append([
          "frameIndex": frameIndex,
          "timeSec": timeSec,
          "box": topLeftBoxDict(topLeft),
          "confidence": conf,
          "lost": lost,
        ])

        CMSampleBufferInvalidate(sample)

        if lowConfStreak >= 5 { break }
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
  static func tracker(_ msg: String) -> NSError {
    NSError(domain: "ExpoVisionTracker", code: -1, userInfo: [NSLocalizedDescriptionKey: msg])
  }
}

private func generateFrame(uri: String, timeSec: Double, jpegQuality: Double) throws -> [String: Any] {
  guard let url = resolveURL(uri) else { throw NSError.tracker("Could not resolve video URI") }
  let asset = AVURLAsset(url: url)
  let imgGen = AVAssetImageGenerator(asset: asset)
  imgGen.appliesPreferredTrackTransform = true
  imgGen.requestedTimeToleranceBefore = .zero
  imgGen.requestedTimeToleranceAfter = .zero
  let cmTime = CMTime(seconds: max(0, timeSec), preferredTimescale: 600)
  let cgImage = try imgGen.copyCGImage(at: cmTime, actualTime: nil)
  let uiImage = UIImage(cgImage: cgImage)
  guard let jpeg = uiImage.jpegData(compressionQuality: CGFloat(jpegQuality)) else {
    throw NSError.tracker("Failed to encode frame")
  }
  let durationSec = CMTimeGetSeconds(asset.duration)
  var vWidth = cgImage.width
  var vHeight = cgImage.height
  var fps: Double = 0
  if let track = asset.tracks(withMediaType: .video).first {
    vWidth = Int(track.naturalSize.width)
    vHeight = Int(track.naturalSize.height)
    fps = Double(track.nominalFrameRate)
  }
  return [
    "imageBase64": jpeg.base64EncodedString(),
    "imageWidth": cgImage.width,
    "imageHeight": cgImage.height,
    "naturalWidth": vWidth,
    "naturalHeight": vHeight,
    "durationSec": durationSec,
    "frameRate": fps,
    "timeSec": timeSec,
  ]
}

private func resolveURL(_ uri: String) -> URL? {
  if uri.hasPrefix("file://") { return URL(string: uri) }
  if uri.hasPrefix("ph://") || uri.hasPrefix("assets-library://") {
    // expo-image-picker normally returns file:// paths after copyToCacheDirectory.
    // ph:// URIs need PHAsset → AVAsset resolution; out of scope for v1.
    return nil
  }
  if uri.hasPrefix("/") { return URL(fileURLWithPath: uri) }
  return URL(string: uri)
}

// Convert a top-left-origin normalized box (the JS coordinate convention) to
// Vision's bottom-left origin and back.
private func flipYNormalized(_ box: CGRect) -> CGRect {
  return CGRect(x: box.origin.x, y: 1.0 - box.origin.y - box.size.height, width: box.size.width, height: box.size.height)
}

private func topLeftBoxDict(_ box: CGRect) -> [String: CGFloat] {
  return ["x": box.origin.x, "y": box.origin.y, "width": box.size.width, "height": box.size.height]
}
