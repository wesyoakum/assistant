require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoTemplateTracker'
  s.version        = package['version']
  s.summary        = 'Template-matching video object tracker with motion prediction'
  s.description    = 'Tracks a small target through a video via per-frame NCC against a template cropped from the user-drawn box, using velocity-based search-window prediction.'
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

  s.frameworks = 'AVFoundation', 'CoreMedia', 'CoreVideo', 'CoreImage', 'UIKit'
end
