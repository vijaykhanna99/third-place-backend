import AVFoundation
import CoreGraphics
import CoreMedia
import CoreText
import CoreVideo
import Foundation
import VideoToolbox

// make-bundle — renders a stereoscopic test clip (left/right eye with
// horizontal parallax, a moving marker, a big label and a running clock),
// encodes it as MV-HEVC and writes an fMP4 HLS bundle:
//
//   <out>/index.m3u8                 master (REQ-VIDEO-LAYOUT="CH-STEREO")
//   <out>/hd/playlist.m3u8           media playlist
//   <out>/hd/init.mp4, segment-0000N.m4s
//
// Usage: make-bundle --out DIR [--label MAIN] [--seconds 20] [--fps 30]
//                    [--width 1920 --height 1080] [--hue 0.6] [--bitrate 8000000]

struct Options {
    var out = "bundle"
    var label = "MAIN"
    var seconds = 20.0
    var fps = 30
    var width = 1920
    var height = 1080
    var hue = 0.6
    var bitrate = 8_000_000
    var segmentSeconds = 2.0
    /// Also write a spatial QuickTime file (same frames) that Files/Photos/Safari on
    /// visionOS play stereoscopically without any server.
    var mov: String?
}

func parse(_ args: [String]) -> Options {
    var o = Options()
    var i = 0
    func value() -> String { i += 1; return i < args.count ? args[i] : "" }
    while i < args.count {
        switch args[i] {
        case "--out": o.out = value()
        case "--label": o.label = value()
        case "--seconds": o.seconds = Double(value()) ?? o.seconds
        case "--fps": o.fps = Int(value()) ?? o.fps
        case "--width": o.width = Int(value()) ?? o.width
        case "--height": o.height = Int(value()) ?? o.height
        case "--hue": o.hue = Double(value()) ?? o.hue
        case "--bitrate": o.bitrate = Int(value()) ?? o.bitrate
        case "--segment-seconds": o.segmentSeconds = Double(value()) ?? o.segmentSeconds
        case "--mov": o.mov = value()
        case "-h", "--help":
            print("usage: make-bundle --out DIR [--label MAIN] [--seconds 20] [--fps 30] [--width 1920 --height 1080] [--hue 0.6] [--bitrate 8000000] [--mov FILE.mov]")
            exit(0)
        default:
            FileHandle.standardError.write("unknown argument \(args[i])\n".data(using: .utf8)!)
            exit(2)
        }
        i += 1
    }
    return o
}

// MARK: - Frame rendering

final class FrameRenderer {
    let width: Int
    let height: Int
    let label: String
    let hue: CGFloat
    private let pool: CVPixelBufferPool

    init(width: Int, height: Int, label: String, hue: Double) {
        self.width = width
        self.height = height
        self.label = label
        self.hue = CGFloat(hue)
        let attrs: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey: width,
            kCVPixelBufferHeightKey: height,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
        ]
        var pool: CVPixelBufferPool?
        CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &pool)
        self.pool = pool!
    }

    /// `eye` is -1 for the left eye and +1 for the right; parallax shifts foreground objects.
    func render(time: Double, eye: Int) -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
        let pb = buffer!
        CVPixelBufferLockBaseAddress(pb, [])
        defer { CVPixelBufferUnlockBaseAddress(pb, []) }
        let ctx = CGContext(
            data: CVPixelBufferGetBaseAddress(pb),
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(pb),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        )!
        let w = CGFloat(width), h = CGFloat(height)

        // Background: a slowly breathing gradient so bitrate is not trivially zero.
        let base = CGColor(colorSpace: CGColorSpaceCreateDeviceRGB(), components: hsv(hue, 0.55, 0.35 + 0.05 * sin(time)))!
        ctx.setFillColor(base)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        // Depth grid: far objects barely move between eyes, near objects move more.
        ctx.setStrokeColor(CGColor(gray: 1, alpha: 0.18))
        ctx.setLineWidth(2)
        for i in 0..<12 {
            let x = CGFloat(i) * w / 12 + CGFloat(eye) * 2
            ctx.move(to: CGPoint(x: x, y: 0)); ctx.addLine(to: CGPoint(x: x, y: h))
        }
        ctx.strokePath()

        // Near marker: orbits, with strong parallax (appears in front of the screen plane).
        let orbit = time * 0.8
        let cx = w / 2 + cos(orbit) * w * 0.3 + CGFloat(eye) * 18
        let cy = h / 2 + sin(orbit) * h * 0.25
        ctx.setFillColor(CGColor(colorSpace: CGColorSpaceCreateDeviceRGB(), components: hsv(fmod(hue + 0.5, 1), 0.8, 1))!)
        ctx.fillEllipse(in: CGRect(x: cx - 90, y: cy - 90, width: 180, height: 180))

        // Text: label, eye marker and a running clock (UI text is at screen depth: no parallax).
        draw(text: label, size: h * 0.22, at: CGPoint(x: w / 2, y: h * 0.62), in: ctx, weight: .bold)
        draw(text: String(format: "%05.1f s", time), size: h * 0.08, at: CGPoint(x: w / 2, y: h * 0.40), in: ctx, weight: .regular)
        draw(text: eye < 0 ? "L" : "R", size: h * 0.10, at: CGPoint(x: eye < 0 ? w * 0.08 : w * 0.92, y: h * 0.90), in: ctx, weight: .bold)
        return pb
    }

    private func draw(text: String, size: CGFloat, at center: CGPoint, in ctx: CGContext, weight: CGFloat) {
        let font = CTFontCreateWithName(weight > 0.5 ? "Helvetica-Bold" as CFString : "Helvetica" as CFString, size, nil)
        let attrs: [CFString: Any] = [
            kCTFontAttributeName: font,
            kCTForegroundColorAttributeName: CGColor(gray: 1, alpha: 0.95),
        ]
        let attributed = CFAttributedStringCreate(nil, text as CFString, attrs as CFDictionary)!
        let line = CTLineCreateWithAttributedString(attributed)
        let bounds = CTLineGetBoundsWithOptions(line, [])
        ctx.saveGState()
        ctx.textPosition = CGPoint(x: center.x - bounds.width / 2, y: center.y - bounds.height / 2)
        CTLineDraw(line, ctx)
        ctx.restoreGState()
    }

    private func hsv(_ h: CGFloat, _ s: CGFloat, _ v: CGFloat) -> [CGFloat] {
        let i = floor(h * 6), f = h * 6 - i
        let p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s)
        switch Int(i) % 6 {
        case 0: return [v, t, p, 1]
        case 1: return [q, v, p, 1]
        case 2: return [p, v, t, 1]
        case 3: return [p, q, v, 1]
        case 4: return [t, p, v, 1]
        default: return [v, p, q, 1]
        }
    }
}

extension CGFloat {
    static let bold: CGFloat = 1
    static let regular: CGFloat = 0
}

// MARK: - HLS segment sink

final class SegmentSink: NSObject, AVAssetWriterDelegate {
    let dir: URL
    private(set) var segments: [(name: String, duration: Double)] = []
    private var index = 0
    var failure: Error?

    init(dir: URL) { self.dir = dir }

    func assetWriter(_ writer: AVAssetWriter, didOutputSegmentData segmentData: Data, segmentType: AVAssetSegmentType, segmentReport: AVAssetSegmentReport?) {
        do {
            switch segmentType {
            case .initialization:
                try segmentData.write(to: dir.appendingPathComponent("init.mp4"))
            case .separable:
                index += 1
                let name = String(format: "segment-%05d.m4s", index)
                try segmentData.write(to: dir.appendingPathComponent(name))
                let duration = segmentReport?.trackReports.first?.duration.seconds ?? 0
                segments.append((name, duration))
            @unknown default:
                break
            }
        } catch {
            failure = error
        }
    }
}

// MARK: - Main

let options = parse(Array(CommandLine.arguments.dropFirst()))
let outURL = URL(fileURLWithPath: options.out)
let variantDir = outURL.appendingPathComponent("hd")
try? FileManager.default.removeItem(at: outURL)
try FileManager.default.createDirectory(at: variantDir, withIntermediateDirectories: true)

let sink = SegmentSink(dir: variantDir)
let writer = try AVAssetWriter(contentType: UTType(AVFileType.mp4.rawValue)!)
writer.outputFileTypeProfile = .mpeg4AppleHLS
writer.preferredOutputSegmentInterval = CMTime(seconds: options.segmentSeconds, preferredTimescale: 600)
writer.initialSegmentStartTime = .zero
writer.delegate = sink

// MV-HEVC: two layers, left eye = layer/view 0, right eye = layer/view 1.
let multiview: [CFString: Any] = [
    kVTCompressionPropertyKey_MVHEVCVideoLayerIDs: [0, 1] as CFArray,
    kVTCompressionPropertyKey_MVHEVCViewIDs: [0, 1] as CFArray,
    kVTCompressionPropertyKey_MVHEVCLeftAndRightViewIDs: [0, 1] as CFArray,
    kVTCompressionPropertyKey_HasLeftStereoEyeView: true,
    kVTCompressionPropertyKey_HasRightStereoEyeView: true,
    kVTCompressionPropertyKey_HeroEye: kCMFormatDescriptionHeroEye_Left,
    kVTCompressionPropertyKey_StereoCameraBaseline: 63_000,  // micrometres: typical interpupillary distance
    kVTCompressionPropertyKey_HorizontalDisparityAdjustment: 0,
    // Spatial-video tagging so visionOS treats the file as stereo content.
    kVTCompressionPropertyKey_ProjectionKind: kCMFormatDescriptionProjectionKind_Rectilinear,
    kVTCompressionPropertyKey_HorizontalFieldOfView: 63_000,  // millidegrees
    kVTCompressionPropertyKey_AverageBitRate: options.bitrate,
    kVTCompressionPropertyKey_MaxKeyFrameInterval: options.fps * Int(options.segmentSeconds),
    kVTCompressionPropertyKey_AllowFrameReordering: false,
]
let settings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.hevc,
    AVVideoWidthKey: options.width,
    AVVideoHeightKey: options.height,
    AVVideoCompressionPropertiesKey: multiview,
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputTaggedPixelBufferGroupAdaptor(
    assetWriterInput: input,
    sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: options.width,
        kCVPixelBufferHeightKey as String: options.height,
    ]
)
guard writer.canAdd(input) else { fatalError("writer refuses the video input") }
writer.add(input)
guard writer.startWriting() else { fatalError("startWriting failed: \(String(describing: writer.error))") }
writer.startSession(atSourceTime: .zero)

// Optional spatial .mov: a second writer fed the same tagged frames.
var movWriter: AVAssetWriter?
var movInput: AVAssetWriterInput?
var movAdaptor: AVAssetWriterInputTaggedPixelBufferGroupAdaptor?
if let movPath = options.mov {
    let movURL = URL(fileURLWithPath: movPath)
    try? FileManager.default.removeItem(at: movURL)
    let mw = try AVAssetWriter(outputURL: movURL, fileType: .mov)
    let mi = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    mi.expectsMediaDataInRealTime = false
    let ma = AVAssetWriterInputTaggedPixelBufferGroupAdaptor(
        assetWriterInput: mi,
        sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: options.width,
            kCVPixelBufferHeightKey as String: options.height,
        ]
    )
    guard mw.canAdd(mi) else { fatalError("mov writer refuses the video input") }
    mw.add(mi)
    guard mw.startWriting() else { fatalError("mov startWriting failed: \(String(describing: mw.error))") }
    mw.startSession(atSourceTime: .zero)
    movWriter = mw
    movInput = mi
    movAdaptor = ma
}

let renderer = FrameRenderer(width: options.width, height: options.height, label: options.label, hue: options.hue)
let frameCount = Int(options.seconds * Double(options.fps))
let queue = DispatchQueue(label: "make-bundle.encode")
let done = DispatchSemaphore(value: 0)
var frame = 0
input.requestMediaDataWhenReady(on: queue) {
    while input.isReadyForMoreMediaData {
        if frame >= frameCount {
            input.markAsFinished()
            done.signal()
            return
        }
        let t = Double(frame) / Double(options.fps)
        let pts = CMTime(value: CMTimeValue(frame), timescale: CMTimeScale(options.fps))
        let left = renderer.render(time: t, eye: -1)
        let right = renderer.render(time: t, eye: 1)
        let tagged = [
            CMTaggedBuffer(tags: [.videoLayerID(0), .stereoView(.leftEye)], pixelBuffer: left),
            CMTaggedBuffer(tags: [.videoLayerID(1), .stereoView(.rightEye)], pixelBuffer: right),
        ]
        if !adaptor.appendTaggedBuffers(tagged, withPresentationTime: pts) {
            FileHandle.standardError.write("append failed at frame \(frame): \(String(describing: writer.error))\n".data(using: .utf8)!)
            exit(1)
        }
        if let movAdaptor, let movInput {
            // The .mov input is driven from this loop too; wait for it when it lags.
            while !movInput.isReadyForMoreMediaData { usleep(2000) }
            if !movAdaptor.appendTaggedBuffers(tagged, withPresentationTime: pts) {
                FileHandle.standardError.write("mov append failed at frame \(frame): \(String(describing: movWriter?.error))\n".data(using: .utf8)!)
                exit(1)
            }
        }
        frame += 1
        if frame % (options.fps * 5) == 0 { print("  \(frame)/\(frameCount) frames") }
    }
}
done.wait()
let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
finished.wait()
if writer.status != .completed { fatalError("encoding failed: \(String(describing: writer.error))") }
if let movWriter, let movInput {
    movInput.markAsFinished()
    let movDone = DispatchSemaphore(value: 0)
    movWriter.finishWriting { movDone.signal() }
    movDone.wait()
    if movWriter.status != .completed { fatalError("mov encoding failed: \(String(describing: movWriter.error))") }
    print("wrote spatial video \(movWriter.outputURL.path)")
}
if let failure = sink.failure { fatalError("segment write failed: \(failure)") }

// Playlists. REQ-VIDEO-LAYOUT marks the variant as stereoscopic (HLS spec rev. 12).
let target = Int(ceil(sink.segments.map(\.duration).max() ?? options.segmentSeconds))
var media = """
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:\(target)
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init.mp4"

"""
for s in sink.segments {
    media += String(format: "#EXTINF:%.5f,\n%@\n", s.duration, s.name)
}
media += "#EXT-X-ENDLIST\n"
try media.write(to: variantDir.appendingPathComponent("playlist.m3u8"), atomically: true, encoding: .utf8)

let master = """
#EXTM3U
#EXT-X-VERSION:12
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=\(Int(Double(options.bitrate) * 1.2)),AVERAGE-BANDWIDTH=\(options.bitrate),RESOLUTION=\(options.width)x\(options.height),FRAME-RATE=\(options.fps).000,CODECS="hvc1.2.4.L153.B0",VIDEO-RANGE=SDR,REQ-VIDEO-LAYOUT="CH-STEREO"
hd/playlist.m3u8

"""
try master.write(to: outURL.appendingPathComponent("index.m3u8"), atomically: true, encoding: .utf8)

let total = sink.segments.reduce(0) { $0 + $1.duration }
print("wrote \(sink.segments.count) segments (\(String(format: "%.1f", total)) s) to \(outURL.path)")
