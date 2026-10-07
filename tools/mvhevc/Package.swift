// swift-tools-version:5.9
import PackageDescription

// macOS command-line tool that renders a synthetic stereoscopic clip, encodes
// it as MV-HEVC with VideoToolbox (Apple silicon, macOS 14+) and writes an HLS
// bundle in the layout the upload pipeline expects. Used to watch a real stream
// end to end without waiting for production footage.
let package = Package(
    name: "mvhevc-tools",
    platforms: [.macOS("15.0")],
    targets: [
        .executableTarget(name: "make-bundle", path: "Sources/make-bundle")
    ],
    swiftLanguageVersions: [.v5]
)
