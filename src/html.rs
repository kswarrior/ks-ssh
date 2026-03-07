pub const PAGE: &str = r#"
<!DOCTYPE html>
<html>
<head>
    <title>KS SSH Terminal</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        html, body {
            margin: 0;
            padding: 0;
            height: 100dvh;
            width: 100%;
            background: #000;
            color: #fff;
        }

        /* Top bar */
        .top {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: #0a0a0a;
            height:38px;
            border-bottom: 1px solid #0050ff;
            border-radius: 5px;
            padding: 5px 12px;
        }

        .left-top {
            display: flex;
            align-items: center;
        }

        .hamburger {
            width: 25px;
            height: 18px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            cursor: pointer;
        }
        .hamburger span {
            display: block;
            height: 3px;
            background: #fff;
            border-radius: 2px;
        }

        .title {
            font-size: 25px;
            margin-left: 10px;
        }

        #status {
            font-size: 14px;
        }

        /* Sidebar */
        #sidebar {
            position: fixed;
            top: 0;
            left: -250px;
            width: 175px;
            background: #000;
            border-right: 1px solid #0050ff;
            transition: left 0.3s ease;
            padding: 10px;
            height: 100%;
            box-sizing: border-box;
            z-index: 1000;
        }
        #sidebar.open {
            left: 0;
        }
        
        .s-title {
            font-size: 20px;
            margin-left: 10px;
            display: inline-block;
        }
        .s-hamburger {
            cursor: pointer;
            display: inline-block;
            margin-left: 25px;
            font-size: 15px;
        }

        /* Terminal container */
        #terminal {
            height: calc(100% - 125px);
            width: 100%;
            background: #080808;
        }

        /* Input area */
        #input-area {
            display: flex;
            padding: 16px 8px;
            background: #000;
            border-top: 1px solid #0050ff;
            border-radius: 5px;
        }
        #cmd-input {
            flex: 1;
            padding: 12px 5px;
            font-family: monospace;
            font-size: 15px;
            border-radius: 8px;
            background: #000;
            color: #fff;
            border: 1px solid #0050ff;
            outline: none;
        }
        #send-btn {
            margin-left: 5px;
            padding: 8px 16px;
            background: #0050ff;
            color: #fff;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: bold;
            transition: background 0.3s ease, transform 0.3s ease;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        #send-btn:hover {
            background: #003bb3;
            transform: translateY(-1px);
        }

        /* Scrollbar styling */
        ::-webkit-scrollbar {
            width: 8px;
        }
        ::-webkit-scrollbar-track { background: #0a0a0a; }
        ::-webkit-scrollbar-thumb {
            background-color: #0050ff;
            border-radius: 4px;
        }

        @media (max-width: 768px) {
            .title { font-size: 18px; }
            #status { font-size: 12px; }
            #cmd-input { font-size: 12px; }
            #send-btn { font-size: 12px; }
        }
        @media (max-width: 480px) {
            .title { font-size: 16px; }
            #status { font-size: 11px; }
            #cmd-input { font-size: 11px; }
            #send-btn { font-size: 11px; }
        }
    </style>
</head>
<body>

    <!-- Sidebar -->
    <div id="sidebar">
        <div><p class="s-title">𝑲𝑺 𝑺𝑺𝑯</p><span class="s-hamburger" onclick="toggleSidebar()"> ⟨⟨⟨⟨⟨</span></div>
        <div>
            <p>Terminals ›</p>
        </div>
    </div>

    <!-- Top bar -->
    <div class="top">
        <div class="left-top">
            <div class="hamburger" onclick="toggleSidebar()">
                <span></span>
                <span></span>
                <span></span>
            </div>
            <h1 class="title">𝑲𝑺 𝑺𝑺𝑯</h1>
        </div>
        <p id="status">Connecting...</p>
    </div>

    <!-- Terminal -->
    <div id="terminal"></div>

    <!-- Input -->
    <div id="input-area">
        <input id="cmd-input" placeholder="Type command..." />
        <button id="send-btn">Send</button>
    </div>

    <!-- Scripts -->
    <script src="https://cdn.jsdelivr.net/npm/xterm@5.5.0/lib/xterm.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
    <script>
        const term = new Terminal({cols:80, rows:24, cursorBlink:true});
        const fitAddon = new FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        term.open(document.getElementById('terminal'));
        fitAddon.fit();

        const ws = new WebSocket('ws://' + location.host + '/ws');
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => console.log('WS connected');
        ws.onmessage = (event) => {
            if (typeof event.data === 'string') {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'url') {
                        document.getElementById('status').innerText = `Public URL: ${data.url}`;
                    }
                } catch {
                    term.write(event.data);
                }
            } else {
                term.write(new Uint8Array(event.data));
            }
        };

        term.onData((data) => ws.send(data));

        const input = document.getElementById('cmd-input');
        const sendBtn = document.getElementById('send-btn');

        function sendCommand() {
            if(input.value.trim() !== "") {
                ws.send(input.value + "\n");
                input.value = "";
            }
        }

        sendBtn.onclick = sendCommand;
        input.addEventListener("keydown", (e) => { if(e.key==="Enter"){ sendCommand(); } });

        window.addEventListener("resize", () => fitAddon.fit());

        // Sidebar toggle
        function toggleSidebar() {
            document.getElementById('sidebar').classList.toggle('open');
        }

        // Close sidebar when clicking outside
        document.addEventListener('click', function(event) {
            const sidebar = document.getElementById('sidebar');
            const hamburger = document.querySelector('.hamburger');
            if(sidebar.classList.contains('open') &&
               !sidebar.contains(event.target) &&
               !hamburger.contains(event.target)) {
                sidebar.classList.remove('open');
            }
        });
    </script>
</body>
</html>
"#;
