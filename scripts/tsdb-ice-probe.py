# -*- coding: utf-8 -*-
"""TSDB Ice API 冒烟：连接 ATRTDBServer，验证实时值与历史查询。"""
import sys
import datetime

sys.path.insert(0, r'D:\doc\taineng\光伏\智道')

import Ice
import types
import sys as _sys


def _openModule(name):
    """Ice 3.8 shim：老式生成代码（slice2py 3.4）需要 openModule。"""
    parts = [p for p in name.split('::') if p]
    mod = _sys.modules
    cur = None
    for i, p in enumerate(parts):
        path = '.'.join(parts[: i + 1])
        if path not in mod:
            m = types.ModuleType(path)
            m.__package__ = path
            mod[path] = m
            if cur is not None:
                setattr(cur, p, m)
        cur = mod[path]
    return cur


if not hasattr(Ice, 'openModule'):
    Ice.openModule = _openModule


class _EnumBase:
    """Ice 3.8 shim：替代 Ice 3.7 的 EnumBase。"""
    def __init__(self, _n, _v):
        self._name = _n
        self._value = _v
    def name(self):
        return self._name
    def value(self):
        return self._value
    def __str__(self):
        return self._name
    def __repr__(self):
        return f'{type(self).__name__}.{self._name}'
    def __eq__(self, other):
        return self is other
    def __hash__(self):
        return id(self)


def _createTempClass():
    """Ice 3.8 shim：替代 Ice 3.7 的 createTempClass，返回临时占位类。"""
    class _Temp:
        pass
    return _Temp


if not hasattr(Ice, 'createTempClass'):
    Ice.createTempClass = _createTempClass
if not hasattr(Ice, 'EnumBase'):
    Ice.EnumBase = _EnumBase
if not hasattr(Ice, '_struct_marker'):
    Ice._struct_marker = object()

import IcePy
_orig_defineValue = IcePy.defineValue
def _defineValue_compat(*args):
    if len(args) == 8:
        return _orig_defineValue(args[0], args[1], args[2], (), False, None, args[3])
    return _orig_defineValue(*args)
IcePy.defineValue = _defineValue_compat

if not hasattr(IcePy, 'defineClass'):
    def _defineClass_compat(*args):
        class _DummyType:
            pass
        return _DummyType()
    IcePy.defineClass = _defineClass_compat

import AT_RTDB_API_ice

HOST, PORT = '192.168.101.54', 9001


def local_time_to_ole(s):
    local = datetime.datetime.strptime(s, '%Y-%m-%d %H:%M:%S')
    delta = local - datetime.datetime(1899, 12, 30)
    return delta.days + delta.seconds / 86400


def ole_to_local(t):
    return (datetime.datetime(1899, 12, 30) + datetime.timedelta(days=t)).strftime('%Y-%m-%d %H:%M:%S')


initData = Ice.InitializationData()
initData.properties = Ice.createProperties()
initData.properties.setProperty('Ice.Default.EncodingVersion', '1.0')
initData.properties.setProperty('Ice.MessageSizeMax', '102400000')
communicator = Ice.initialize(initData)

base = communicator.stringToProxy(f'ATRTDBServer:default -h {HOST} -p {PORT} -z')
rtdb = Ice.openModule('ANTAI').ATRTDBAPIPrx.checkedCast(base)
if not rtdb:
    raise RuntimeError('Invalid proxy')
print(f'[1] 连接成功 ATRTDBServer {HOST}:{PORT}')

count, err = rtdb.TAGActualCount()
print(f'[2] TAGActualCount: {count} err={err}')

cnt, tags, errors, remain, fetchId = rtdb.TAGQueryEx('*')
print(f'[3] TAGQueryEx(*): 首批 {len(tags)} remain={remain}')
for t in tags[:5]:
    print(f'    {t.tagName}  comment={t.comment!r} dataType={t.dataType}')
sample = [t.tagName for t in tags[:3]]

probe = ['HWNBYC174_1O_100620000001001', '35KV1SEG0007_2O_100620000005171'] + sample
items, err = rtdb.RTDQuery(probe)
print(f'[4] RTDQuery({len(probe)} tags): err={err}')
for it in items:
    print(f'    {it.tagName}  value={it.value}  quality={it.quality}  time={ole_to_local(it.timestamp)}')

param = AT_RTDB_API_ice.ANTAI.ATRTDBQueryParam() if hasattr(AT_RTDB_API_ice, 'ANTAI') else None
ANTAI = Ice.openModule('ANTAI')
param = ANTAI.ATRTDBQueryParam()
param.type = ANTAI.ATRTDBHDQueryType.RawByTime
param.tagNames = [probe[0]]
param.startTime = local_time_to_ole('2024-08-10 00:00:00')
param.endTime = local_time_to_ole('2024-08-10 01:00:00')
param.intervalByMS = -1
param.numberOfSamples = -1
cnt, dataList, err = rtdb.HDQuery(param)
print(f'[5] HDQuery RawByTime {probe[0]} [00:00,01:00): count={cnt} err={err}')
for it in dataList[:10]:
    print(f'    {it.tagName}  value={it.value}  quality={it.quality}  time={ole_to_local(it.timestamp)}')

communicator.destroy()
print('[6] Ice 冒烟完成')