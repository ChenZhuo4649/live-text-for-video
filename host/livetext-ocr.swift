// livetext-ocr.swift
// Chrome 无感实况文本 —— OCR 后端（借 macOS Vision 框架，与 Safari 实况文本同一引擎）
//
// 用法：
//   livetext-ocr <图片> [--langs=ja-JP,zh-Hans,en-US] [--fast]   识别，结果以 JSON 打到 stdout
//   livetext-ocr draw <图片> <json> [-o <输出图>]                把识别框画到图上，肉眼校验坐标准不准
//   livetext-ocr langs                                           列出本机 Vision 支持的所有识别语言
//   livetext-ocr  （无参数）                                       Native Messaging stdio 模式（第 2 批实现）
//
// 坐标约定：输出的是 Vision 的归一化坐标，原点在左下，与 AppKit / CGContext 一致，无需翻转。

import Foundation
import ImageIO
import Vision
import Darwin
import os

// 进程一启动就留痕：哪怕后面崩了，也能确认浏览器到底有没有把它拉起来、传了什么参数。
// 这里刻意不引入 AppKit —— 后台进程去连 WindowServer 是没必要的负担。
func trace(_ s: String) {
    let p = (NSHomeDirectory() as NSString)
        .appendingPathComponent("Library/Logs/livetext-trace.log")
    let line = "[\(Date())] \(s)\n"
    guard let d = line.data(using: .utf8) else { return }
    if let fh = FileHandle(forWritingAtPath: p) {
        fh.seekToEndOfFile()
        fh.write(d)
        try? fh.close()
    } else {
        try? d.write(to: URL(fileURLWithPath: p))
    }
}

trace("① 进程启动 pid=\(ProcessInfo.processInfo.processIdentifier) argv=\(CommandLine.arguments)")

// MARK: - 数据结构

struct Line: Codable {
    let text: String
    let x: Double
    let y: Double
    let w: Double
    let h: Double
    let conf: Double
}

struct ImgSize: Codable {
    let w: Int
    let h: Int
}

struct OcrResult: Codable {
    let ok: Bool
    let image: ImgSize
    let langs: [String]
    let elapsed_ms: Int
    let count: Int
    let lines: [Line]
    let error: String?
}

// Vision 的 completion handler 标了 @Sendable，用这个盒子收集结果以通过并发检查
final class LineBox: @unchecked Sendable {
    var lines: [Line] = []
}

// MARK: - 基础工具

func loadCGImage(_ path: String) -> CGImage? {
    let expanded = (path as NSString).expandingTildeInPath
    let url = URL(fileURLWithPath: expanded)
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

func stderr(_ s: String) {
    FileHandle.standardError.write(s.data(using: .utf8)!)
}

// MARK: - OCR

func runOCR(_ cg: CGImage, langs: [String], fast: Bool) -> [Line] {
    let box = LineBox()

    let req = VNRecognizeTextRequest { request, _ in
        guard let obs = request.results as? [VNRecognizedTextObservation] else { return }
        for o in obs {
            guard let cand = o.topCandidates(1).first else { continue }
            let b = o.boundingBox
            box.lines.append(Line(text: cand.string,
                                  x: Double(b.origin.x),
                                  y: Double(b.origin.y),
                                  w: Double(b.size.width),
                                  h: Double(b.size.height),
                                  conf: Double(cand.confidence)))
        }
    }
    req.recognitionLevel = fast ? .fast : .accurate

    // langs 传 ["auto"] 时交给 Vision 自己判断语言（最接近 Safari 实况文本的行为）。
    // 否则用显式指定的语言列表 —— 中日语言包互斥，同时给会让中文被日化。
    if langs.count == 1 && langs[0].lowercased() == "auto" {
        req.automaticallyDetectsLanguage = true
    } else {
        req.recognitionLanguages = langs
    }
    req.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do {
        try handler.perform([req])
    } catch {
        stderr("Vision 报错: \(error)\n")
    }

    // 排序成阅读顺序：先上后下、先左后右（Vision 原点在左下，故 y 越大越靠上）
    return box.lines.sorted { a, b in
        if abs(a.y - b.y) > 0.012 { return a.y > b.y }
        return a.x < b.x
    }
}

// MARK: - 画框校验

func drawBoxes(_ cg: CGImage, _ lines: [Line], out outPath: String) {
    let W = cg.width
    let H = cg.height

    guard let ctx = CGContext(data: nil,
                              width: W,
                              height: H,
                              bitsPerComponent: 8,
                              bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        stderr("无法创建绘图上下文\n")
        return
    }

    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: W, height: H))
    ctx.setLineWidth(max(2.0, Double(W) / 500.0))

    for l in lines {
        // 高置信度画红框；低置信度画琥珀色框，一眼看出"这行可能不准"
        if l.conf < 0.5 {
            ctx.setStrokeColor(CGColor(red: 1.0, green: 0.72, blue: 0.10, alpha: 1.0))
        } else {
            ctx.setStrokeColor(CGColor(red: 1.0, green: 0.23, blue: 0.19, alpha: 1.0))
        }
        let r = CGRect(x: CGFloat(l.x) * CGFloat(W),
                       y: CGFloat(l.y) * CGFloat(H),
                       width: CGFloat(l.w) * CGFloat(W),
                       height: CGFloat(l.h) * CGFloat(H))
        ctx.stroke(r)
    }

    guard let outImg = ctx.makeImage() else {
        stderr("无法生成输出图\n")
        return
    }
    let url = URL(fileURLWithPath: (outPath as NSString).expandingTildeInPath)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
        stderr("无法写入 \(outPath)\n")
        return
    }
    CGImageDestinationAddImage(dest, outImg, nil)
    CGImageDestinationFinalize(dest)
}

// MARK: - Native Messaging stdio 模式
//
// Chrome 通过 stdin/stdout 与本进程通信，协议为：
//   4 字节小端长度前缀 + UTF-8 JSON 正文
// 关键：stdout 是协议通道，任何日志都必须走 stderr，否则协议会被污染。

func cgImageFromData(_ data: Data) -> CGImage? {
    guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

/// 从 stdin 精确读 count 字节；EOF 或出错返回 nil
func readExact(_ count: Int) -> Data? {
    var buf = [UInt8](repeating: 0, count: count)
    var got = 0
    while got < count {
        let n = read(STDIN_FILENO, &buf[got], count - got)
        if n <= 0 { return nil }
        got += n
    }
    return Data(buf)
}

func readMessage() -> [String: Any]? {
    guard let header = readExact(4) else { return nil }
    let b = [UInt8](header)
    // 手动拼字节，避免依赖内存对齐
    let len = UInt32(b[0]) | (UInt32(b[1]) << 8) | (UInt32(b[2]) << 16) | (UInt32(b[3]) << 24)
    guard len > 0, len <= 64 * 1024 * 1024 else { return nil }
    guard let body = readExact(Int(len)) else { return nil }
    return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
}

func sendMessage(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    var len = UInt32(data.count)
    FileHandle.standardOutput.write(Data(bytes: &len, count: 4))
    FileHandle.standardOutput.write(data)
}

// 调试日志：确认 host 有没有被浏览器启动、有没有收到消息。
// 双通道：① 系统日志（不依赖文件权限，用 `log show` 读）② 二进制同目录 + ~/Library/Logs
let hostLogger = Logger(subsystem: "com.zhuo.livetext", category: "host")

let debugLogPath: String = {
    let exe = CommandLine.arguments[0]
    let dir = (exe as NSString).deletingLastPathComponent
    return (dir as NSString).appendingPathComponent("stdio.log")
}()

func dbg(_ s: String) {
    hostLogger.log("\(s, privacy: .public)")

    let line = "[\(Date())] \(s)\n"
    guard let data = line.data(using: .utf8) else { return }
    let home = NSHomeDirectory() as NSString
    let targets = [
        debugLogPath,
        home.appendingPathComponent("Library/Logs/livetext-host.log"),
    ]
    for p in targets {
        if let fh = FileHandle(forWritingAtPath: p) {
            fh.seekToEndOfFile()
            fh.write(data)
            try? fh.close()
        } else {
            try? data.write(to: URL(fileURLWithPath: p))
        }
    }
}

func runStdioMode() {
    dbg("stdio 模式启动 pid=\(ProcessInfo.processInfo.processIdentifier)")

    while let msg = readMessage() {
        let langs = (msg["langs"] as? [String]) ?? ["zh-Hans", "en-US"]
        dbg("收到消息 langs=\(langs)")

        guard let b64 = msg["png"] as? String,
              let pngData = Data(base64Encoded: b64),
              let cg = cgImageFromData(pngData) else {
            dbg("图片解码失败")
            sendMessage(["ok": false, "error": "缺少 png 字段，或图片解码失败"])
            continue
        }

        trace("收到图片 \(pngData.count) 字节 \(cg.width)x\(cg.height)")

        let t0 = Date()
        let lines = runOCR(cg, langs: langs, fast: false)
        let ms = Int(Date().timeIntervalSince(t0) * 1000)
        dbg("识别完成 \(lines.count) 行 \(ms)ms")

        sendMessage([
            "ok": true,
            "elapsed_ms": ms,
            "count": lines.count,
            "lines": lines.map {
                ["text": $0.text, "x": $0.x, "y": $0.y,
                 "w": $0.w, "h": $0.h, "conf": $0.conf] as [String: Any]
            }
        ])
        dbg("已回复")
    }

    dbg("stdin EOF 或读取失败，退出")
}

// MARK: - 参数

func parseLangs(_ args: [String]) -> [String] {
    for a in args where a.hasPrefix("--langs=") {
        let v = String(a.dropFirst("--langs=".count))
        let list = v.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if !list.isEmpty { return list }
    }
    // 默认值经真实截图实测选定（见 PoC-结果报告.md）：
    // 中日语言包互斥 —— 一旦同时给出，中文会被日化成繁体/日文汉字变体（师→姉、试→試、给→給、这→汶），
    // 且耗时翻近一倍。故默认只用 zh-Hans,en-US；看日文内容请显式 --langs=ja-JP,en-US
    // 默认交给 Vision 自动检测语言 —— 最接近 Safari 实况文本的行为。
    // 实测：同一张日文试卷画面，['zh-Hans','en-US'] 只识别 11 行，auto 能识别 44 行。
    return ["auto"]
}

func usage() {
    print("""
    livetext-ocr —— macOS Vision OCR（与 Safari 实况文本同一引擎）

      livetext-ocr <图片> [--langs=ja-JP,zh-Hans,en-US] [--min-conf=0.5] [--fast]
          识别图片，JSON 结果打到 stdout
          警告：--fast 快约 3 倍，但中日文会识别崩坏，且 conf 恒为 0.5 不可用

      livetext-ocr draw <图片> <json> [-o <输出图>]
          把 JSON 里的识别框画回图上，用于肉眼校验坐标

      livetext-ocr langs
          列出本机 Vision 支持的语言

      livetext-ocr
          （无参数）Native Messaging stdio 模式
    """)
}

// MARK: - 主流程

let args = Array(CommandLine.arguments.dropFirst())
trace("② 解析参数 count=\(args.count) args=\(args)")

let knownCommands: Set<String> = ["draw", "langs", "-h", "--help", "help"]

// 没有参数 → 浏览器拉起的 Native Messaging 模式
if args.isEmpty {
    trace("③ 无参数，进入 stdio 模式")
    runStdioMode()
    exit(0)
}

let cmd = args[0]
let cmdIsExistingFile = FileManager.default.fileExists(
    atPath: (cmd as NSString).expandingTildeInPath
)

// 参数既不是已知命令、也不是真实存在的图片 → 判定为浏览器拉起的模式。
// 这样即使浏览器额外塞了参数，也不会被误当成图片路径而直接退出。
if !knownCommands.contains(cmd) && !cmdIsExistingFile {
    trace("③ 参数无法识别（\(cmd)），转入 stdio 模式")
    runStdioMode()
    exit(0)
}

trace("③ 作为命令行工具运行，cmd=\(cmd)")

switch cmd {
case "-h", "--help", "help":
    usage()
    exit(0)

case "langs":
    if let langs = try? VNRecognizeTextRequest.supportedRecognitionLanguages(
        for: .accurate, revision: VNRecognizeTextRequestRevision3) {
        print(langs.joined(separator: "\n"))
    } else {
        stderr("取语言列表失败\n")
        exit(1)
    }
    exit(0)

case "draw":
    guard args.count >= 3 else {
        stderr("用法: livetext-ocr draw <图片> <json> [-o <输出图>]\n")
        exit(1)
    }
    let imgPath = args[1]
    let jsonPath = args[2]
    var outPath = "boxes.png"
    if let i = args.firstIndex(of: "-o"), i + 1 < args.count {
        outPath = args[i + 1]
    }

    guard let cg = loadCGImage(imgPath) else {
        stderr("读不到图片: \(imgPath)\n")
        exit(1)
    }
    guard let data = FileManager.default.contents(atPath: (jsonPath as NSString).expandingTildeInPath) else {
        stderr("读不到 JSON: \(jsonPath)\n")
        exit(1)
    }

    struct Wrapper: Codable {
        let lines: [Line]
    }
    guard let wrapped = try? JSONDecoder().decode(Wrapper.self, from: data) else {
        stderr("JSON 解析失败\n")
        exit(1)
    }

    drawBoxes(cg, wrapped.lines, out: outPath)
    print("已输出: \(outPath)")
    exit(0)

default:
    // 把第一个参数当图片路径
    let imgPath = cmd
    guard let cg = loadCGImage(imgPath) else {
        stderr("读不到图片: \(imgPath)\n")
        usage()
        exit(1)
    }

    let langs = parseLangs(args)
    let fast = args.contains("--fast")

    // 置信度下限。注意：只有 accurate 模式的 conf 有区分度，fast 模式的 conf 恒为 0.5，此参数形同虚设
    var minConf = 0.0
    for a in args where a.hasPrefix("--min-conf=") {
        if let v = Double(a.dropFirst("--min-conf=".count)) { minConf = v }
    }

    let t0 = Date()
    var lines = runOCR(cg, langs: langs, fast: fast)
    let rawCount = lines.count
    if minConf > 0 {
        lines = lines.filter { $0.conf >= minConf }
    }
    let ms = Int(Date().timeIntervalSince(t0) * 1000)
    if minConf > 0 && rawCount != lines.count {
        stderr("置信度过滤 --min-conf=\(minConf)：丢弃 \(rawCount - lines.count) 行低置信度结果\n")
    }

    let res = OcrResult(ok: true,
                        image: ImgSize(w: cg.width, h: cg.height),
                        langs: langs,
                        elapsed_ms: ms,
                        count: lines.count,
                        lines: lines,
                        error: nil)

    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
    if let out = try? enc.encode(res), let s = String(data: out, encoding: .utf8) {
        print(s)
    }

    stderr("模式=\(fast ? "fast" : "accurate")  语言=\(langs.joined(separator: ","))  识别 \(lines.count) 行  耗时 \(ms) ms\n")
    exit(0)
}
