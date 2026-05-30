require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoTrackNet'
  s.version        = package['version']
  s.summary        = 'TrackNet video ball tracker (Core ML)'
  s.description    = 'Sports-ball tracking via a TrackNet CNN — takes 3 consecutive frames, outputs a heatmap of the ball position. Tennis-trained weights from yastrebksv/TrackNet.'
  s.author         = 'whyapp'
  s.homepage       = 'https://whyapp.us'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.swift_version  = '5.4'

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,mm,swift}'

  # Xcode auto-compiles .mlpackage to .mlmodelc and bundles via resource_bundles.
  s.resource_bundles = {
    'ExpoTrackNetModel' => ['*.mlpackage']
  }

  s.frameworks = 'AVFoundation', 'CoreMedia', 'CoreVideo', 'CoreImage', 'CoreML', 'Accelerate', 'UIKit'
end
