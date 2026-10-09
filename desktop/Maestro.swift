import AppKit
import WebKit

@main
final class MaestroApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var web: WKWebView!
    private var server: Process?
    private var statusItem: NSStatusItem!
    private var localURL = URL(string: "http://localhost:4210/setup.html")!
    static func main() {
        let app = NSApplication.shared
        let delegate = MaestroApp()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
    func applicationDidFinishLaunching(_ note: Notification) {
        let menu = NSMenu(), appMenu = NSMenu(), item = NSMenuItem()
        menu.addItem(item); item.submenu = appMenu
        appMenu.addItem(withTitle: "Open Maestro", action: #selector(showWindow), keyEquivalent: "0")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Maestro", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        NSApp.mainMenu = menu
        let edit = NSMenu(title: "Edit"), editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        editItem.submenu = edit; menu.addItem(editItem)
        for (name, action, key) in [("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: name, action: Selector(action), keyEquivalent: key)
        }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "Maestro"
        statusItem.menu = appMenu.copy() as? NSMenu
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "chooseFolder")
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self; web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Maestro"; window.minSize = NSSize(width: 640, height: 580)
        window.backgroundColor = NSColor(red: 0.063, green: 0.078, blue: 0.067, alpha: 1)
        window.contentView = web; window.center(); showWindow()
        web.loadHTMLString("<html><body style='background:#101413;color:#e5efdf;font:20px system-ui;padding:60px'>Starting Maestro…</body></html>", baseURL: nil)
        start()
    }
    @objc private func showWindow() { window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool { showWindow(); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ note: Notification) { server?.terminate() }
    private func start() {
        guard let resources = Bundle.main.resourceURL else { return }
        let fm = FileManager.default
        let builtBesideRepo = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent(".local")
        let saved = UserDefaults.standard.string(forKey: "dataDirectory")
        let data = saved.map { URL(fileURLWithPath: $0) } ?? (fm.fileExists(atPath: builtBesideRepo.appendingPathComponent("config.json").path) ? builtBesideRepo : fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Maestro"))
        UserDefaults.standard.set(data.path, forKey: "dataDirectory")
        do {
            try fm.createDirectory(at: data, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            if let bytes = try? Data(contentsOf: data.appendingPathComponent("config.json")),
               let config = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], let port = config["localPort"] as? Int {
                localURL = URL(string: "http://localhost:\(port)/setup.html")!
            }
        } catch { failure("Maestro could not create its private storage folder."); return }
        let health = localURL.deletingLastPathComponent().appendingPathComponent("api/health")
        URLSession.shared.dataTask(with: health) { bytes, response, _ in
            DispatchQueue.main.async {
                if let bytes, let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], object["name"] as? String == "Maestro" {
                    self.web.load(URLRequest(url: self.localURL)); return
                }
                let process = Process(); process.executableURL = resources.appendingPathComponent(".tools/node/bin/node")
                process.currentDirectoryURL = resources
                process.arguments = ["bridge/src/desktop.js"]
                var env = ProcessInfo.processInfo.environment
                env["MAESTRO_DATA"] = data.path
                env["MAESTRO_PYTHON"] = resources.appendingPathComponent(".tools/python/bin/python3").path
                env["PYTHONDONTWRITEBYTECODE"] = "1"
                env["MAESTRO_FIRMWARE"] = resources.appendingPathComponent("firmware").path
                process.environment = env
                let log = data.appendingPathComponent("app.log")
                if !fm.fileExists(atPath: log.path) { fm.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
                do {
                    let output = try FileHandle(forWritingTo: log); try output.seekToEnd()
                    process.standardOutput = output; process.standardError = output
                    try process.run(); self.server = process; self.waitForBridge(health, attempt: 0)
                } catch { self.failure("Maestro could not start. Reinstall the app and try again.") }
            }
        }.resume()
    }
    private func waitForBridge(_ url: URL, attempt: Int) {
        URLSession.shared.dataTask(with: url) { bytes, response, _ in
            DispatchQueue.main.async {
                if (response as? HTTPURLResponse)?.statusCode == 200 { self.web.load(URLRequest(url: self.localURL)); return }
                if attempt >= 40 || self.server?.isRunning == false { self.failure("The bridge did not start. Check app.log in Maestro’s data folder, then reopen the app."); return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.waitForBridge(url, attempt: attempt + 1) }
            }
        }.resume()
    }
    private func failure(_ text: String) { let alert = NSAlert(); alert.messageText = "Could not start Maestro"; alert.informativeText = text; alert.runModal() }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "chooseFolder", message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.host == "localhost", message.frameInfo.request.url?.port == localURL.port else { return }
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window) { result in
            if result == .OK, let url = panel.url, let data = try? JSONSerialization.data(withJSONObject: [url.path]), let encoded = String(data: data, encoding: .utf8) {
                self.web.evaluateJavaScript("window.maestroFolder(\(encoded)[0])", completionHandler: nil)
            }
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "about" || (url.scheme == "http" && url.host == "localhost" && url.port == localURL.port) { decisionHandler(.allow); return }
        if url.scheme == "https" { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if url.host == "localhost" && url.port == localURL.port { web.load(URLRequest(url: url)) }
            else if url.scheme == "https" { NSWorkspace.shared.open(url) }
        }
        return nil
    }
}
