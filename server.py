#!/usr/bin/env python3
"""
暖暖小窝 - 局域网协作服务器
提供 HTTP 文件服务和 WebSocket 房间管理

启动方式: python3 server.py
默认端口: HTTP 9000, WebSocket 9001
"""

import asyncio
import json
import socket
import threading
import http.server
import os
import sys
from datetime import datetime

try:
    import websockets
except ImportError:
    print("错误: 需要 websockets 库")
    print("安装: pip3 install websockets")
    sys.exit(1)

# 配置
HTTP_PORT = 9000
WS_PORT = 9001
HOST = '0.0.0.0'
FIXED_ROOM_ID = '暖暖小窝'

# ============================================================
# HTTP 静态文件服务器
# ============================================================
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

def run_http():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = http.server.HTTPServer((HOST, HTTP_PORT), QuietHandler)
    server.serve_forever()

# ============================================================
# WebSocket 房间管理
# ============================================================
# 固定房间状态
room_state = {
    'chat_history': {},
    'todos': [],
    'foods': ['黄焖鸡', '麻辣烫', '牛肉面', '寿司', '炸鸡', '沙拉', '饺子', '螺蛳粉']
}
members = {}    # username -> websocket
clients = {}    # websocket -> username


async def handle_client(websocket):
    """处理 WebSocket 客户端连接"""
    username = None

    try:
        async for message in websocket:
            try:
                data = json.loads(message)
                msg_type = data.get('type')

                if msg_type == 'join':
                    username = await handle_join(websocket, data)
                elif username:
                    await handle_message(websocket, username, data)

            except json.JSONDecodeError:
                pass
            except Exception as e:
                print(f'[WS 错误] {e}')

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        if username:
            await handle_leave(websocket, username)


async def handle_join(websocket, data):
    """加入固定房间"""
    username = data.get('username', '').strip()

    if not username:
        await websocket.send(json.dumps({'type': 'error', 'message': '请输入昵称'}))
        return None

    # 如果昵称已在线，踢掉旧连接
    if username in members:
        old_ws = members[username]
        try:
            await old_ws.send(json.dumps({'type': 'kicked', 'message': '相同昵称从其他设备登录'}))
            await old_ws.close()
        except:
            pass
        if old_ws in clients:
            del clients[old_ws]

    members[username] = websocket
    clients[websocket] = username

    # 发送房间状态给新加入者
    await websocket.send(json.dumps({
        'type': 'room-joined',
        'room_id': FIXED_ROOM_ID,
        'username': username,
        'members': list(members.keys()),
        'state': room_state
    }))

    # 通知其他人
    await broadcast({
        'type': 'member-joined',
        'username': username,
        'members': list(members.keys())
    }, exclude=websocket)

    print(f'[加入] {username} (共 {len(members)} 人在线)')
    return username


async def handle_message(websocket, username, data):
    """处理消息"""
    msg_type = data.get('type')

    if msg_type == 'chat':
        msg_id = data.get('msg_id', f"msg-{datetime.now().timestamp()}")
        text = data.get('text', '')
        to_user = data.get('to_user')

        chat_key = get_chat_key(username, to_user) if to_user else f"{username}->all"
        if chat_key not in room_state['chat_history']:
            room_state['chat_history'][chat_key] = []

        msg = {
            'id': msg_id,
            'text': text,
            'from': username,
            'to': to_user,
            'time': datetime.now().isoformat()
        }
        room_state['chat_history'][chat_key].append(msg)

        if to_user:
            target_ws = members.get(to_user)
            if target_ws:
                await target_ws.send(json.dumps({'type': 'chat', 'message': msg}))
        else:
            await broadcast({'type': 'chat', 'message': msg}, exclude=websocket)

        await websocket.send(json.dumps({'type': 'chat-receipt', 'msg_id': msg_id}))

    elif msg_type == 'todo-add':
        todo = data.get('todo', {})
        todo['created_by'] = username
        room_state['todos'].append(todo)
        await broadcast({'type': 'todo-added', 'todo': todo}, exclude=websocket)

    elif msg_type == 'todo-toggle':
        todo_id = data.get('id')
        for t in room_state['todos']:
            if t['id'] == todo_id:
                t['done'] = not t.get('done', False)
                break
        await broadcast({'type': 'todo-toggled', 'id': todo_id}, exclude=websocket)

    elif msg_type == 'todo-delete':
        todo_id = data.get('id')
        room_state['todos'] = [t for t in room_state['todos'] if t['id'] != todo_id]
        await broadcast({'type': 'todo-deleted', 'id': todo_id}, exclude=websocket)

    elif msg_type == 'food-add':
        food = data.get('food', '')
        if food and food not in room_state['foods']:
            room_state['foods'].append(food)
        await broadcast({'type': 'food-added', 'food': food}, exclude=websocket)

    elif msg_type == 'food-remove':
        food = data.get('food', '')
        if food in room_state['foods']:
            room_state['foods'].remove(food)
        await broadcast({'type': 'food-removed', 'food': food}, exclude=websocket)

    elif msg_type == 'sync-request':
        await websocket.send(json.dumps({
            'type': 'sync',
            'state': room_state,
            'members': list(members.keys())
        }))

    else:
        await broadcast(data, exclude=websocket)


async def handle_leave(websocket, username):
    """处理离开"""
    if username in members:
        del members[username]

    if websocket in clients:
        del clients[websocket]

    await broadcast({
        'type': 'member-left',
        'username': username,
        'members': list(members.keys())
    })

    print(f'[离开] {username} (共 {len(members)} 人在线)')


async def broadcast(data, exclude=None):
    """广播消息给所有人"""
    message = json.dumps(data)
    for ws in list(members.values()):
        if ws != exclude:
            try:
                await ws.send(message)
            except:
                pass


def get_chat_key(a, b):
    return '<->'.join(sorted([a, b]))


# ============================================================
# 获取局域网 IP
# ============================================================
def get_lan_ips():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith('127.'):
                ips.add(ip)
    except:
        pass
    return list(ips)


# ============================================================
# 主入口
# ============================================================
async def ws_main():
    async with websockets.serve(handle_client, HOST, WS_PORT):
        print('')
        print('  ========================================')
        print('  🌿  暖暖小窝 - 局域网服务器已启动')
        print('  ========================================')
        print('')
        print(f'  📱 本机访问:  http://localhost:{HTTP_PORT}')
        print('')
        ips = get_lan_ips()
        if ips:
            print(f'  📡 局域网访问 (同一WiFi下的设备):')
            for ip in ips:
                print(f'     → http://{ip}:{HTTP_PORT}')
            print('')
        print(f'  🔌 WebSocket: ws://localhost:{WS_PORT}')
        print('')
        print('  输入昵称即可进入，所有人共享同一个房间')
        print('  按 Ctrl+C 停止服务器')
        print('')
        await asyncio.Future()


def main():
    t = threading.Thread(target=run_http, daemon=True)
    t.start()

    try:
        asyncio.run(ws_main())
    except KeyboardInterrupt:
        print('\n  服务器已停止\n')


if __name__ == '__main__':
    main()
