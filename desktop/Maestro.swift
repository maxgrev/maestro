import AppKit
import WebKit

@main
final class MaestroApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var web: WKWebView!
    private var server: Process?
    private var statusItem: NSStatusItem!
    private var awake: NSObjectProtocol?
    private var localURL = URL(string: "http://localhost:4210/setup.html")!
    static func main() {
        let app = NSApplication.shared
        let delegate = MaestroApp()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
    func applicationDidFinishLaunching(_ note: Notification) {
        awake = ProcessInfo.processInfo.beginActivity(options: [.idleSystemSleepDisabled], reason: "Keep your Maestro agents available while the app is open")
        let menu = NSMenu(), appMenu = NSMenu(), item = NSMenuItem()
        menu.addItem(item); item.submenu = appMenu
        appMenu.addItem(withTitle: "About Maestro", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Open Maestro", action: #selector(showWindow), keyEquivalent: "0")
        appMenu.addItem(withTitle: "Settings…", action: #selector(openSetup), keyEquivalent: ",")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Maestro", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        NSApp.mainMenu = menu
        let edit = NSMenu(title: "Edit"), editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        editItem.submenu = edit; menu.addItem(editItem)
        for (name, action, key) in [("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: name, action: Selector(action), keyEquivalent: key)
        }
        edit.insertItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x", at: 0)
        edit.insertItem(.separator(), at: 0)
        edit.insertItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z", at: 0)
        edit.insertItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z", at: 0)
        let viewMenu = NSMenu(title: "View"), viewItem = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
        viewItem.submenu = viewMenu; menu.addItem(viewItem)
        viewMenu.addItem(withTitle: "Conversations", action: #selector(openConversations), keyEquivalent: "1")
        viewMenu.addItem(withTitle: "Inbox", action: #selector(openInbox), keyEquivalent: "2")
        viewMenu.addItem(withTitle: "Setup", action: #selector(openSetup), keyEquivalent: "3")
        let windowMenu = NSMenu(title: "Window"), windowItem = NSMenuItem(title: "Window", action: nil, keyEquivalent: "")
        windowItem.submenu = windowMenu; menu.addItem(windowItem); NSApp.windowsMenu = windowMenu
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        let helpMenu = NSMenu(title: "Help"), helpItem = NSMenuItem(title: "Help", action: nil, keyEquivalent: "")
        helpItem.submenu = helpMenu; menu.addItem(helpItem); NSApp.helpMenu = helpMenu
        helpMenu.addItem(withTitle: "Credits", action: #selector(openCredits), keyEquivalent: "")
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "Maestro"
        statusItem.menu = appMenu.copy() as? NSMenu
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "chooseFolder")
        configuration.userContentController.add(self, name: "appearance")
        configuration.userContentController.addUserScript(WKUserScript(source: "window.maestroNative = true; document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('native-app'));", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self; web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "Maestro"; window.minSize = NSSize(width: 640, height: 580)
        window.titleVisibility = .hidden; window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(red: 0.106, green: 0.118, blue: 0.102, alpha: 1)
                : NSColor(red: 0.973, green: 0.976, blue: 0.961, alpha: 1)
        }
        window.contentView = web
        if !window.setFrameUsingName("MaestroMainWindow") { window.center() }
        window.setFrameAutosaveName("MaestroMainWindow"); showWindow()
        web.loadHTMLString("""
            <html><head><meta name='color-scheme' content='light dark'><style>
            :root{color-scheme:light dark}body{background:#f8f9f5;color:#252c25;font:15px system-ui;padding:90px 64px}h1{font:600 32px 'Avenir Next',system-ui;letter-spacing:-1px}p{color:#60695d}.track{height:8px;border-radius:4px;background:#e7ebe1;max-width:340px;margin-top:32px}@media(prefers-color-scheme:dark){body{background:#1b1e1a;color:#ecf0e7}p{color:#b0b9a8}.track{background:#30392b}}
            </style></head><body><h1>Maestro</h1><p>Starting…</p><div class='track'></div></body></html>
            """, baseURL: nil)
        start()
    }
    @objc private func showWindow() { window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc private func openConversations() { navigate(to: "") }
    @objc private func openInbox() { navigate(to: "inbox.html") }
    @objc private func openSetup() { navigate(to: "setup.html") }
    @objc private func openCredits() { navigate(to: "characters/credits.html") }
    private func navigate(to path: String) {
        showWindow()
        web.load(URLRequest(url: localURL.deletingLastPathComponent().appendingPathComponent(path)))
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool { showWindow(); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ note: Notification) {
        server?.terminate()
        if let awake { ProcessInfo.processInfo.endActivity(awake) }
    }
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
        guard message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.host == "localhost", message.frameInfo.request.url?.port == localURL.port else { return }
        if message.name == "appearance", let mode = message.body as? String {
            switch mode {
            case "light": window.appearance = NSAppearance(named: .aqua)
            case "dark": window.appearance = NSAppearance(named: .darkAqua)
            case "system": window.appearance = nil
            default: break
            }
            return
        }
        guard message.name == "chooseFolder" else { return }
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
