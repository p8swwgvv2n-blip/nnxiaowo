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
# WebSocket 房间管理服务器
# ============================================================
rooms = {}      # room_id -> { "host": username, "members": {username: ws}, "state": {...} }
clients = {}    # ws -> { "room_id": str, "username": str }


async def handle_client(websocket):
    """处理 WebSocket 客户端连接"""
    client_info = None

    try:
        async for message in websocket:
            try:
                data = json.loads(message)
                msg_type = data.get('type')

                if msg_type == 'create-room':
                    client_info = await handle_create_room(websocket, data)
                elif msg_type == 'join-room':
                    client_info = await handle_join_room(websocket, data)
                elif msg_type == 'leave':
                    await handle_leave(websocket, client_info)
                    client_info = None
                elif client_info:
                    # 已加入房间的客户端，转发消息
                    await handle_room_message(websocket, client_info, data)

            except json.JSONDecodeError:
                pass
            except Exception as e:
                print(f'[WS 错误] {e}')

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        if client_info:
            await handle_leave(websocket, client_info)


async def handle_create_room(websocket, data):
    """创建房间"""
    room_id = data.get('room_id', '').strip()
    username = data.get('username', '').strip()

    if not room_id or not username:
        await websocket.send(json.dumps({'type': 'error', 'message': '参数不完整'}))
        return None

    if room_id in rooms:
        await websocket.send(json.dumps({'type': 'error', 'message': '房间已存在'}))
        return None

    rooms[room_id] = {
        'host': username,
        'members': {username: websocket},
        'state': {
            'chat_history': {},
            'todos': [],
            'foods': ['黄焖鸡', '麻辣烫', '牛肉面', '寿司', '炸鸡', '沙拉', '饺子', '螺蛳粉']
        }
    }

    info = {'room_id': room_id, 'username': username}
    clients[websocket] = info

    await websocket.send(json.dumps({
        'type': 'room-created',
        'room_id': room_id,
        'username': username
    }))

    print(f'[房间创建] {room_id} by {username}')
    return info


async def handle_join_room(websocket, data):
    """加入房间"""
    room_id = data.get('room_id', '').strip()
    username = data.get('username', '').strip()

    if not room_id or not username:
        await websocket.send(json.dumps({'type': 'error', 'message': '参数不完整'}))
        return None

    if room_id not in rooms:
        await websocket.send(json.dumps({'type': 'error', 'message': '房间不存在'}))
        return None

    room = rooms[room_id]

    if username in room['members']:
        await websocket.send(json.dumps({'type': 'error', 'message': '昵称已被使用'}))
        return None

    room['members'][username] = websocket
    info = {'room_id': room_id, 'username': username}
    clients[websocket] = info

    # 发送完整状态给加入者
    await websocket.send(json.dumps({
        'type': 'room-joined',
        'room_id': room_id,
        'username': username,
        'members': list(room['members'].keys()),
        'state': room['state']
    }))

    # 通知房间内其他人
    await broadcast(room_id, {
        'type': 'member-joined',
        'username': username,
        'members': list(room['members'].keys())
    }, exclude=websocket)

    print(f'[房间加入] {room_id}: {username}')
    return info


async def handle_room_message(websocket, client_info, data):
    """处理房间内消息"""
    room_id = client_info['room_id']
    username = client_info['username']

    if room_id not in rooms:
        return

    room = rooms[room_id]
    msg_type = data.get('type')

    # 根据消息类型处理
    if msg_type == 'chat':
        # 聊天消息 - 存储并转发
        msg_id = data.get('msg_id', f"msg-{datetime.now().timestamp()}")
        text = data.get('text', '')
        to_user = data.get('to_user')

        # 存储到房间状态
        chat_key = get_chat_key(username, to_user) if to_user else f"{username}->all"
        if chat_key not in room['state']['chat_history']:
            room['state']['chat_history'][chat_key] = []

        msg = {
            'id': msg_id,
            'text': text,
            'from': username,
            'to': to_user,
            'time': datetime.now().isoformat()
        }
        room['state']['chat_history'][chat_key].append(msg)

        # 转发
        if to_user:
            target_ws = room['members'].get(to_user)
            if target_ws:
                await target_ws.send(json.dumps({'type': 'chat', 'message': msg}))
        else:
            await broadcast(room_id, {'type': 'chat', 'message': msg}, exclude=websocket)

        # 回执
        await websocket.send(json.dumps({'type': 'chat-receipt', 'msg_id': msg_id}))

    elif msg_type == 'todo-add':
        todo = data.get('todo', {})
        todo['created_by'] = username
        room['state']['todos'].append(todo)
        await broadcast(room_id, {'type': 'todo-added', 'todo': todo}, exclude=websocket)

    elif msg_type == 'todo-toggle':
        todo_id = data.get('id')
        for t in room['state']['todos']:
            if t['id'] == todo_id:
                t['done'] = not t.get('done', False)
                break
        await broadcast(room_id, {'type': 'todo-toggled', 'id': todo_id}, exclude=websocket)

    elif msg_type == 'todo-delete':
        todo_id = data.get('id')
        room['state']['todos'] = [t for t in room['state']['todos'] if t['id'] != todo_id]
        await broadcast(room_id, {'type': 'todo-deleted', 'id': todo_id}, exclude=websocket)

    elif msg_type == 'food-add':
        food = data.get('food', '')
        if food and food not in room['state']['foods']:
            room['state']['foods'].append(food)
        await broadcast(room_id, {'type': 'food-added', 'food': food}, exclude=websocket)

    elif msg_type == 'food-remove':
        food = data.get('food', '')
        if food in room['state']['foods']:
            room['state']['foods'].remove(food)
        await broadcast(room_id, {'type': 'food-removed', 'food': food}, exclude=websocket)

    elif msg_type == 'sync-request':
        await websocket.send(json.dumps({
            'type': 'sync',
            'state': room['state'],
            'members': list(room['members'].keys())
        }))

    else:
        # 未知类型，直接广播
        await broadcast(room_id, data, exclude=websocket)


async def handle_leave(websocket, client_info):
    """处理离开房间"""
    if not client_info:
        return

    room_id = client_info['room_id']
    username = client_info['username']

    if room_id in rooms:
        room = rooms[room_id]
        if username in room['members']:
            del room['members'][username]

        await broadcast(room_id, {
            'type': 'member-left',
            'username': username,
            'members': list(room['members'].keys())
        })

        if not room['members']:
            del rooms[room_id]
            print(f'[房间删除] {room_id} (空)')

    if websocket in clients:
        del clients[websocket]

    print(f'[离开] {username} from {room_id}')


async def broadcast(room_id, data, exclude=None):
    """广播消息给房间所有人"""
    if room_id not in rooms:
        return

    room = rooms[room_id]
    message = json.dumps(data)

    for member_ws in room['members'].values():
        if member_ws != exclude:
            try:
                await member_ws.send(message)
            except:
                pass


def get_chat_key(a, b):
    """生成聊天键（确保双方唯一）"""
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
        print('  按 Ctrl+C 停止服务器')
        print('')
        await asyncio.Future()


def main():
    # 后台启动 HTTP 服务器
    t = threading.Thread(target=run_http, daemon=True)
    t.start()

    # 启动 WebSocket 服务器
    try:
        asyncio.run(ws_main())
    except KeyboardInterrupt:
        print('\n  服务器已停止\n')


if __name__ == '__main__':
    main()
