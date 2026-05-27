require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoLidar'
  s.version        = package['version']
  s.summary        = 'LiDAR depth map access via ARKit'
  s.description    = 'Streams downsampled depth maps from the iPhone Pro LiDAR sensor.'
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

  s.frameworks = 'ARKit'
end
