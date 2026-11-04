"""Headless public room/roster reader. Never joins a game room or logs into Steam."""
import base64
import hashlib
import json
import pathlib
import queue
import re
import threading
import time
import urllib.parse

import msgpack
import requests
import websocket
from public_lobby_wire import decode_roster, roster_request, string_field


class LobbyError(RuntimeError):
    pass


def endpoint(value):
    url = urllib.parse.urlsplit(value)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('endpoint must be an HTTPS URL without credentials or query')
    return value.rstrip('/')


def read_token(cache):
    try:
        token = json.loads(pathlib.Path(cache).read_text(encoding='utf-8'))['token']
        part = token.split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
        uid = claims['uid']
        if not isinstance(uid, str) or not uid or claims['exp'] <= time.time() + 30:
            raise ValueError('expired token')
        return token, uid
    except Exception:
        raise LobbyError('existing token cache is unavailable or expired; refresh with the existing collector') from None


def room_filter(game_mode, cursor=-1, excluded=()):
    return {'gameMode': game_mode, 'subMode': 0, 'status': 2, 'sortType': 3,
            'charId': 0, 'lastSortValue': cursor, 'otherParams': [], 'excludeRoomIds': list(excluded)}


def classify_player(player):
    """Roster isAI is absent for bots on this server; retain it and apply the current client's AI UID rule."""
    result = dict(player)
    uid = player['userInfo'].get('uid', '')
    reported = bool(player.get('isAI'))
    native_bot_uid = isinstance(uid, str) and len(uid) < 10 and 'ai' in uid
    account_uid = isinstance(uid, str) and re.fullmatch('[0-9a-f]{24}', uid) is not None
    result['reportedIsAI'] = reported
    result['isAI'] = reported or native_bot_uid
    result['identityKind'] = 'bot' if result['isAI'] else 'human' if account_uid else 'unknown'
    result['isAISource'] = 'server-flag' if reported else 'client-uid-rule' if native_bot_uid else 'account-uid' if account_uid else 'unknown'
    return result


class PublicLobby:
    def __init__(self, token_cache, game_endpoint='https://p3.gate.darksungame.com/game-server',
                 lobby_endpoint='https://p3.gate.darksungame.com/lobby-server', gap=1.3, timeout=15):
        self.token_cache = str(token_cache)
        self.game_endpoint, self.lobby_endpoint = endpoint(game_endpoint), endpoint(lobby_endpoint)
        self.gap, self.timeout = max(1.0, float(gap)), float(timeout)
        self.http = requests.Session()
        self.ws, self.reader = None, None
        self.messages = queue.Queue(maxsize=4)
        self.stop = threading.Event()
        self.query_lock = threading.Lock()
        self.public_ids = set()
        self.last_request = 0.0
        self.token_fingerprint = None
        self.stats = {'connections': 0, 'rosterRequests': 0, 'httpRequests': 0, 'pings': 0, 'ignoredMessages': 0}

    def _rate(self):
        time.sleep(max(0, self.last_request + self.gap - time.monotonic()))
        self.last_request = time.monotonic()

    def _headers(self, presence=False):
        token, uid = read_token(self.token_cache)
        headers = {'Authorization': 'Bearer ' + token}
        if presence:
            headers['userInfo'] = base64.b64encode(string_field(1, uid)).decode('ascii')
        return headers

    def _http(self, method, url, **options):
        attempts=options.pop('_attempts',3);timeout=options.pop('_timeout',self.timeout)
        for attempt in range(attempts):
            self._rate()
            self.stats['httpRequests'] += 1
            try:
                response = self.http.request(method, url, timeout=timeout, **options)
                if response.status_code in (401, 403):
                    raise LobbyError('server rejected existing authorization')
                if response.status_code in (429, 502, 503, 504) and attempt+1<attempts:
                    try:
                        delay = min(60, max(self.gap, float(response.headers.get('Retry-After', 2 ** (attempt + 1)))))
                    except (ValueError, TypeError):
                        delay = 5
                    time.sleep(delay)
                    options['headers'] = self._headers(presence=url.endswith('/connect'))
                    continue
                response.raise_for_status()
                body = response.json()
                if body.get('code') != 1:
                    raise LobbyError('server returned an unsuccessful response')
                return body['data']
            except LobbyError:
                raise
            except (requests.Timeout, requests.ConnectionError):
                if attempt+1<attempts:
                    time.sleep(2 ** (attempt + 1))
                    options['headers'] = self._headers(presence=url.endswith('/connect'))
                    continue
                raise LobbyError('public lobby HTTP request failed after bounded retries') from None
            except Exception:
                raise LobbyError('public lobby HTTP request failed') from None

    def list_rooms(self, game_mode=0, max_pages=100, progress=None):
        rooms, cursor, reason = {}, -1, 'page-limit'
        pages, exhausted = 0, False
        for _ in range(max_pages):
            data = self._http('POST', self.game_endpoint + '/game/fetchRooms',
                              headers=self._headers(), json=room_filter(game_mode, cursor, rooms))
            pages += 1
            if not isinstance(data, list):
                raise LobbyError('invalid public room list')
            if not data:
                reason, exhausted = 'empty-terminal-page', True
                break
            if not all(isinstance(r, dict) and isinstance(r.get('roomId'), str)
                       and type(r.get('createdTs')) is int for r in data):
                raise LobbyError('invalid public room metadata')
            if cursor >= 0 and any(r['createdTs'] > cursor for r in data):
                reason = 'server-cursor-not-respected'
                break
            new = [r for r in data if r['roomId'] not in rooms]
            if not new:
                reason = 'pagination-stalled'
                break
            rooms.update((r['roomId'], r) for r in data)
            self.public_ids.update(r['roomId'] for r in data if not r.get('isPrivate') and r.get('name') == 'game_room')
            cursor = data[-1]['createdTs']
            if progress:
                progress({'phase': 'rooms', 'pages': pages, 'listedRooms': len(rooms)})
        return list(rooms.values()), {'pages': pages, 'exhausted': exhausted, 'reason': reason,
                                     'scope': 'Public ongoing rooms visible to this account on this node during pagination'}

    def connect(self):
        self.close()
        headers = self._headers(presence=True)
        reservation = self._http('GET', self.lobby_endpoint + '/connect', headers=headers)
        try:
            room = reservation['room']
            # This is only the dedicated account's lobby transport, never a battle room.
            if room['name'] != 'lobby_room':
                raise ValueError('unexpected room kind')
            path = '/' + urllib.parse.quote(room['processId'], safe='') + '/' + urllib.parse.quote(room['roomId'], safe='')
            url = self.lobby_endpoint.replace('https:', 'wss:', 1) + path
            url += '?' + urllib.parse.urlencode({'sessionId': reservation['sessionId']})
            self.ws = websocket.create_connection(url, header=headers, timeout=self.timeout, suppress_origin=True)
            first = self.ws.recv()
            if not isinstance(first, bytes) or not first or first[0] != 10 or b'none' not in first:
                raise ValueError('unsupported lobby handshake')
            self.ws.send_binary(bytes([10]))
            self.token_fingerprint = hashlib.sha256(headers['Authorization'].encode()).digest()
            self.ws.settimeout(1)
            self.messages = queue.Queue(maxsize=4)
            self.stop = threading.Event()
            self.stats['connections'] += 1
            self.reader = threading.Thread(target=self._receive, args=(self.ws, self.stop, self.messages), daemon=True)
            self.reader.start()
        except Exception:
            self.close()
            raise LobbyError('dedicated lobby transport handshake failed') from None

    def _receive(self, socket, stop, messages):
        ping_at = time.monotonic() + 20
        try:
            while not stop.is_set():
                if time.monotonic() >= ping_at:
                    socket.ping(b'public-roster')
                    self.stats['pings'] += 1
                    ping_at = time.monotonic() + 20
                try:
                    raw = socket.recv()  # websocket-client automatically responds to server ping frames.
                except websocket.WebSocketTimeoutException:
                    continue
                if not raw:
                    raise LobbyError('lobby transport closed')
                if not isinstance(raw, bytes):
                    continue
                if raw[0] in (11, 12):
                    raise LobbyError('lobby transport rejected or closed')
                if raw[0] != 13:
                    continue
                unpacker = msgpack.Unpacker(raw=False, strict_map_key=False, max_buffer_size=1024 * 1024)
                unpacker.feed(raw[1:])
                values = list(unpacker)
                if len(values) == 2 and values[0] == 'data' and isinstance(values[1], dict):
                    message = values[1]
                    if message.get('type') == 'FetchLobbyGamePlayersResp':
                        messages.put_nowait(message['data'])
                        continue
                self.stats['ignoredMessages'] += 1
        except Exception:
            if not stop.is_set():
                try:
                    messages.put_nowait(LobbyError('lobby receive stream failed'))
                except queue.Full:
                    pass

    def roster(self, room_id):
        if room_id not in self.public_ids:
            raise ValueError('room must come from the public listing')
        encoded = roster_request(room_id)
        # The response has no room ID: one in-flight request and a fresh session after any timeout are essential.
        with self.query_lock:
            for attempt in range(2):
                try:
                    if self.ws is None:
                        self.connect()
                    else:
                        current = hashlib.sha256(self._headers()['Authorization'].encode()).digest()
                        if current != self.token_fingerprint:
                            self.connect()
                    if not self.messages.empty():
                        raise LobbyError('unexpected queued roster response')
                    self._rate()
                    packet = bytes([13]) + msgpack.packb('data', use_bin_type=True)
                    packet += msgpack.packb({'type': 'FetchLobbyGamePlayersReq', 'data': encoded}, use_bin_type=True)
                    self.ws.send_binary(packet)
                    self.stats['rosterRequests'] += 1
                    response = self.messages.get(timeout=self.timeout)
                    if isinstance(response, Exception):
                        raise response
                    players = [classify_player(p) for p in decode_roster(response)]
                    return {'roomId': room_id, 'observedAt': int(time.time() * 1000), 'players': players,
                            'wireSha256': hashlib.sha256(base64.b64decode(response)).hexdigest()}
                except Exception:
                    self.close()
                    if attempt:
                        raise LobbyError('public roster query failed after an isolated retry') from None
                    time.sleep(2)

    def sweep(self, game_mode=0, max_pages=100, progress=None):
        started = int(time.time() * 1000)
        rooms, coverage = self.list_rooms(game_mode, max_pages, progress)
        snapshots, errors, skipped, incomplete, empty = [], [], [], [], []
        for room in rooms:
            if room.get('isPrivate') or room.get('name') != 'game_room':
                skipped.append(room['roomId'])
                continue
            try:
                snapshot = self.roster(room['roomId'])
                snapshot['room'] = room
                people = snapshot['players']
                if not people:
                    empty.append(room['roomId'])
                    snapshot['rosterStatus'] = 'empty-or-closed'
                elif (len(people) != room.get('playerCount') or
                      len({p['userInfo'].get('uid') for p in people}) != len(people) or
                      any(p.get('identityKind') == 'unknown' or not p['userInfo'].get('uid')
                          or p['userInfo']['uid'].startswith('record-player-')
                          or not p['userInfo'].get('username') for p in people if not p['isAI']) or
                      sum(p.get('identityKind') == 'human' for p in people) != room.get('realPlayerCount')):
                    incomplete.append(room['roomId'])
                    snapshot['rosterStatus'] = 'incomplete-or-changed'
                else:
                    snapshot['rosterStatus'] = 'complete'
                snapshots.append(snapshot)
            except LobbyError:
                errors.append(room['roomId'])
            if progress and (len(snapshots) + len(errors)) % 10 == 0:
                progress({'phase': 'rosters', 'completed': len(snapshots), 'errors': len(errors), 'listedRooms': len(rooms)})
        return {'startedAt': started, 'finishedAt': int(time.time() * 1000), 'gameEndpoint': self.game_endpoint,
                'coverage': coverage, 'listedRooms': len(rooms), 'snapshots': snapshots,
                'failedRoomIds': errors, 'skippedRoomIds': skipped, 'transportStats': dict(self.stats),
                'incompleteRoomIds': incomplete, 'emptyOrClosedRoomIds': empty,
                'completeForListedRooms': coverage['exhausted'] and not errors and not skipped and not incomplete and not empty,
                'scope': 'Public lists and roster fields only; no live boards, private rooms or atomic full-server snapshot'}

    def close(self):
        self.stop.set()
        socket, reader = self.ws, self.reader
        if socket is not None:
            try:
                socket.send_binary(bytes([12]))
            except Exception:
                pass
            try:
                socket.close(timeout=2)
            except Exception:
                pass
        if reader is not None and reader is not threading.current_thread():
            reader.join(timeout=3)
        self.ws, self.reader = None, None
