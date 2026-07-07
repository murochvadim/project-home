import json, ssl, base64, time, os, sys
import websocket
HOST='192.168.1.199'; TF='/opt/media-agent/tv55_bobo_token.txt'
keys=sys.argv[1:] or ['KEY_UP']
tok=open(TF).read().strip() if os.path.exists(TF) else ''
name=base64.b64encode(b'BoBoGame').decode()
u='wss://%s:8002/api/v2/channels/samsung.remote.control?name=%s'%(HOST,name)
if tok: u+='&token=%s'%tok
ws=websocket.create_connection(u, sslopt={'cert_reqs':ssl.CERT_NONE}); ws.settimeout(3)
t=time.time(); ok=False
while time.time()-t<10:
    try: m=json.loads(ws.recv())
    except Exception: continue
    if m.get('event')=='ms.channel.connect': ok=True; break
print('ws connected:',ok)
for k in keys:
    ws.send(json.dumps({'method':'ms.remote.control','params':{'Cmd':'Click','DataOfCmd':k,'Option':'false','TypeOfRemote':'SendRemoteKey'}})); print('sent',k); time.sleep(1.3)
ws.close()
