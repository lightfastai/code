Pod::Spec.new do |s|
  s.name = 'T3StudyCanvas'
  s.version = '1.0.0'
  s.summary = 'Native PencilKit study canvas for T3 Code mobile.'
  s.description = 'Local-first infinite PencilKit canvas with bounded region export.'
  s.author = 'T3 Tools'
  s.homepage = 'https://t3tools.com'
  s.license = { :type => 'UNLICENSED' }
  s.platforms = { :ios => '16.4' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.swift'
  s.frameworks = 'PencilKit', 'UIKit'
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
end
