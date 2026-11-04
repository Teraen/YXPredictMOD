"""Small, bounded decoder for the public room roster's documented client fields."""
import base64


def varint(value):
    if type(value) is not int or value < 0:
        raise ValueError('invalid unsigned integer')
    out = bytearray()
    while value >= 128:
        out.append((value & 127) | 128)
        value >>= 7
    return bytes(out + bytes([value]))


def read_varint(data, offset):
    value = 0
    for shift in range(0, 70, 7):
        if offset >= len(data):
            raise ValueError('truncated varint')
        byte = data[offset]
        offset += 1
        if shift == 63 and byte > 1:
            raise ValueError('oversized varint')
        value |= (byte & 127) << shift
        if byte < 128:
            return value, offset
    raise ValueError('oversized varint')


def fields(data):
    if len(data) > 1024 * 1024:
        raise ValueError('oversized protobuf message')
    offset = 0
    while offset < len(data):
        tag, offset = read_varint(data, offset)
        number, kind = tag >> 3, tag & 7
        if not number:
            raise ValueError('invalid field zero')
        if kind == 0:
            value, offset = read_varint(data, offset)
        else:
            if kind == 2:
                size, offset = read_varint(data, offset)
            elif kind in (1, 5):
                size = 8 if kind == 1 else 4
            else:
                raise ValueError('unsupported wire type')
            if offset + size > len(data):
                raise ValueError('truncated field')
            value = data[offset:offset + size]
            offset += size
        yield number, kind, value


def string_field(number, text):
    raw = text.encode('utf-8')
    return varint(number * 8 + 2) + varint(len(raw)) + raw


def roster_request(room_id):
    if not isinstance(room_id, str) or not 5 <= len(room_id) <= 32 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in room_id):
        raise ValueError('invalid public room ID')
    return base64.b64encode(string_field(1, room_id)).decode('ascii')


def signed32(value):
    value &= 0xffffffff
    return value - 2**32 if value >= 2**31 else value


def decode_roster(encoded):
    result = []
    for number, kind, value in fields(base64.b64decode(encoded, validate=True)):
        if number != 1 or kind != 2:
            continue
        player = {'isAI': False, 'isJudge': False, 'life': 0, 'rank': 0,
                  'charId': 0, 'skinId': 0, 'skinColor': 0, 'userInfo': {}}
        for number, kind, value in fields(value):
            if number == 1 and kind == 2:
                for n, k, v in fields(value):
                    # Lobby session IDs are deliberately not retained in snapshots.
                    if n in (1, 6, 8) and k == 2:
                        player['userInfo'][{1: 'uid', 6: 'username', 8: 'statusInfo'}[n]] = v.decode('utf-8')
                    elif n in (4, 5, 7, 9, 10, 11, 12, 14, 16, 17) and k == 0:
                        key = {4: 'avatarId', 5: 'avatarFrameId', 7: 'status', 9: 'rankScore', 10: 'lastLoginTs',
                               11: 'userInfoBg', 12: 'zunHao', 14: 'platform', 16: 'deleted', 17: 'xianFuStatus'}[n]
                        player['userInfo'][key] = v if n == 10 else signed32(v)
            elif number in (10, 11) and kind == 0:
                player['isAI' if number == 10 else 'isJudge'] = bool(value)
            elif number in (101, 102, 103, 104, 105) and kind == 0:
                player[{101: 'life', 102: 'rank', 103: 'charId', 104: 'skinId', 105: 'skinColor'}[number]] = signed32(value)
        result.append(player)
        if len(result) > 64:
            raise ValueError('oversized roster')
    return result
