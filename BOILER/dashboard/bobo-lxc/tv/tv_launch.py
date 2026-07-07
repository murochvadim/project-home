import time, urllib.request
HOST='192.168.1.199'
def dial(method):
    path='/run' if method=='DELETE' else ''
    try:
        r=urllib.request.Request('http://%s:8080/ws/app/WebBrowser%s'%(HOST,path), data=(b'' if method=='POST' else None), method=method)
        urllib.request.urlopen(r,timeout=6); print('dial',method,'ok')
    except Exception as e: print('dial',method,e)
dial('DELETE'); time.sleep(3)   # close browser
dial('POST')                    # reopen -> lands on home page = game
print('relaunched -> should open on home page (the game)')
