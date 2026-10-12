import http.server
import socket
import sys
import os
from functools import partial

DEFAULT_PORT = 8080

def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip

def find_available_port(start_port=DEFAULT_PORT):
    port = start_port
    while port < 65535:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(('127.0.0.1', port)) != 0:
                return port
        port += 1
    return start_port

class NoCacheHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # スマホ確認時に古いキャッシュが残るのを防ぐ
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    port = find_available_port(DEFAULT_PORT)
    local_ip = get_local_ip()

    handler = partial(NoCacheHTTPRequestHandler, directory=script_dir)
    
    try:
        with http.server.ThreadingHTTPServer(("0.0.0.0", port), handler) as httpd:
            print("=" * 62)
            print("  MatchBoard ローカルサーバーが起動しました")
            print("=" * 62)
            print()
            print("  [PCで開く場合]")
            print(f"  -> http://localhost:{port}/")
            print()
            print("  [スマホで開く場合] ※PCと同じWi-Fiに接続してください")
            print(f"  -> http://{local_ip}:{port}/")
            print()
            print("  ※終了するには、このウィンドウで [Ctrl + C] を押すか")
            print("    ウィンドウ右上の [x] ボタンを閉じてください。")
            print("=" * 62)
            print()

            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nサーバーを停止しました。")
        sys.exit(0)

if __name__ == '__main__':
    main()
