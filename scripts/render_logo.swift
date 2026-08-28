import AppKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let outputDirectory = root.appendingPathComponent("src-tauri/icons")
let fileManager = FileManager.default

func drawLogo(size: Int) -> CGImage? {
    guard let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                                  bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    let scale = CGFloat(size) / 1024
    context.scaleBy(x: scale, y: scale)
    context.translateBy(x: 0, y: 1024)
    context.scaleBy(x: 1, y: -1)

    let background = CGColorSpaceCreateDeviceRGB()
    let bgGradient = CGGradient(colorsSpace: background, colors: [
        CGColor(red: 0.063, green: 0.176, blue: 0.212, alpha: 1),
        CGColor(red: 0.027, green: 0.067, blue: 0.086, alpha: 1)
    ] as CFArray, locations: [0, 1])!
    let frame = CGRect(x: 24, y: 24, width: 976, height: 976)
    context.saveGState()
    context.addPath(CGPath(roundedRect: frame, cornerWidth: 224, cornerHeight: 224, transform: nil))
    context.clip()
    context.drawLinearGradient(bgGradient, start: CGPoint(x: 24, y: 24), end: CGPoint(x: 1000, y: 1000), options: [])
    context.restoreGState()

    func strokeArc(_ rect: CGRect, _ start: CGFloat, _ end: CGFloat, _ color: CGColor, _ width: CGFloat, _ alpha: CGFloat = 1) {
        context.saveGState(); context.setStrokeColor(color.copy(alpha: alpha)!); context.setLineWidth(width); context.setLineCap(.round)
        context.addArc(center: CGPoint(x: rect.midX, y: rect.midY), radius: rect.width / 2, startAngle: start, endAngle: end, clockwise: false); context.strokePath(); context.restoreGState()
    }
    let halo = CGRect(x: 174, y: 152, width: 676, height: 676)
    strokeArc(halo, 0.22, 1.37, CGColor(red: 0.176, green: 0.408, blue: 0.467, alpha: 1), 16, 0.45)
    strokeArc(halo, -0.08, 0.52, CGColor(red: 0.616, green: 0.91, blue: 1, alpha: 1), 24, 0.9)
    strokeArc(halo, 3.64, 4.24, CGColor(red: 0.373, green: 0.82, blue: 0.898, alpha: 1), 24, 0.75)

    let bodyPath = CGMutablePath()
    bodyPath.move(to: CGPoint(x: 512, y: 214)); bodyPath.addCurve(to: CGPoint(x: 260, y: 462), control1: CGPoint(x: 373, y: 214), control2: CGPoint(x: 260, y: 325))
    bodyPath.addLine(to: CGPoint(x: 260, y: 656)); bodyPath.addCurve(to: CGPoint(x: 322, y: 734), control1: CGPoint(x: 260, y: 701), control2: CGPoint(x: 286, y: 734))
    bodyPath.addCurve(to: CGPoint(x: 388, y: 701), control1: CGPoint(x: 345, y: 734), control2: CGPoint(x: 369, y: 712)); bodyPath.addLine(to: CGPoint(x: 433, y: 756)); bodyPath.addLine(to: CGPoint(x: 512, y: 695)); bodyPath.addLine(to: CGPoint(x: 591, y: 756)); bodyPath.addLine(to: CGPoint(x: 636, y: 701))
    bodyPath.addCurve(to: CGPoint(x: 702, y: 734), control1: CGPoint(x: 655, y: 712), control2: CGPoint(x: 679, y: 734)); bodyPath.addCurve(to: CGPoint(x: 764, y: 656), control1: CGPoint(x: 764, y: 701), control2: CGPoint(x: 764, y: 701)); bodyPath.addLine(to: CGPoint(x: 764, y: 462)); bodyPath.addCurve(to: CGPoint(x: 512, y: 214), control1: CGPoint(x: 764, y: 325), control2: CGPoint(x: 651, y: 214)); bodyPath.closeSubpath()
    let bodyGradient = CGGradient(colorsSpace: background, colors: [CGColor(red: 0.894, green: 0.988, blue: 1, alpha: 1), CGColor(red: 0.616, green: 0.91, blue: 1, alpha: 1), CGColor(red: 0.333, green: 0.749, blue: 0.827, alpha: 1)] as CFArray, locations: [0, 0.5, 1])!
    context.saveGState(); context.addPath(bodyPath); context.clip(); context.drawLinearGradient(bodyGradient, start: CGPoint(x: 512, y: 214), end: CGPoint(x: 512, y: 756), options: []); context.restoreGState()
    context.addPath(bodyPath); context.setStrokeColor(CGColor(red: 0.137, green: 0.263, blue: 0.302, alpha: 1)); context.setLineWidth(24); context.setLineJoin(.round); context.strokePath()
    context.setFillColor(CGColor(red: 0.071, green: 0.192, blue: 0.227, alpha: 1)); context.fillEllipse(in: CGRect(x: 396, y: 442, width: 54, height: 54)); context.fillEllipse(in: CGRect(x: 574, y: 442, width: 54, height: 54))
    context.setStrokeColor(CGColor(red: 0.137, green: 0.263, blue: 0.302, alpha: 1)); context.setLineWidth(20); context.setLineCap(.round); context.addArc(center: CGPoint(x: 512, y: 548), radius: 59, startAngle: .pi * 0.18, endAngle: .pi * 0.82, clockwise: false); context.strokePath()
    context.setFillColor(CGColor(red: 1, green: 0.878, blue: 0.659, alpha: 1)); context.fillEllipse(in: CGRect(x: 733, y: 219, width: 40, height: 40))
    return context.makeImage()
}

func writePNG(_ image: CGImage, to url: URL) {
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { return }
    CGImageDestinationAddImage(destination, image, nil); CGImageDestinationFinalize(destination)
}

try? fileManager.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
for size in [32, 128, 256, 512, 1024] {
    if let image = drawLogo(size: size) {
        let filename = size == 256 ? "128x128@2x.png" : size == 1024 ? "icon.png" : size == 512 ? "512x512.png" : "\(size)x\(size).png"
        writePNG(image, to: outputDirectory.appendingPathComponent(filename))
        if size == 256 { writePNG(image, to: outputDirectory.appendingPathComponent("256x256.png")) }
    }
}
