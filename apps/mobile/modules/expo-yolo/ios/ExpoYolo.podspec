require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoYolo'
  s.version        = package['version']
  s.summary        = 'On-device YOLOv3-Tiny object detection via Core ML'
  s.description    = 'Bounding-box object detection with COCO labels (80 classes).'
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

  # .mlpackage (Core ML's modern bundle format) gets compiled to .mlmodelc
  # by Xcode's build phase and bundled into the app. We resource_bundle it
  # so the compiled output ships in its own bundle and we can locate it
  # deterministically.
  s.resource_bundles = {
    'ExpoYoloModels' => ['*.mlpackage', '*.mlmodel']
  }

  s.frameworks = 'Vision', 'CoreML', 'UIKit'
end
