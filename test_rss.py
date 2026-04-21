import urllib.request as r
import re
import ssl
import sys

handles = [
    ('Life in Space', '@LifeInSpace1'), 
    ('VideoFootages', '@VideoFootagesTV'), 
    ('KVUE', '@KVUE'), 
    ('Bloomberg Originals', '@bloombergoriginals'), 
    ('WFAA', '@WFAA'), 
    ('Tell it', '@TellIt'), 
    ('KREM News 2', '@KREM2'), 
    ('WAAY 31 News', '@waay31news'), 
    ('FOX 13 News Utah', '@FOX13NewsUtah'), 
    ('Marques Brownlee', '@mkbhd'), 
    ('Bloomberg News', '@bloombergnews'), 
    ('Anadolu English', '@AnadoluEnglish'), 
    ('LEGO', '@LEGO'), 
    ('Boston Dynamics', '@BostonDynamics'), 
    ('Apple', '@Apple'), 
    ('Homefield', '@Homefield'), 
    ('A24', '@A24'), 
    ('Grunge', '@Grunge'), 
    ('Netflix', '@Netflix'), 
    ('Pixar', '@pixar')
]

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

for name, h in handles:
    if not h.startswith('@'):
        h = '@' + h
    try:
        req = r.Request(f'https://www.youtube.com/{h}', headers={'User-Agent': 'Mozilla/5.0'})
        res = r.urlopen(req, context=ctx, timeout=8)
        html = res.read().decode('utf-8')
        m = re.search(r'"browseId":"(UC[a-zA-Z0-9_-]+)"', html)
        if m:
            print(f"{name} ({h}) -> https://www.youtube.com/feeds/videos.xml?channel_id={m.group(1)}")
        else:
            print(f"{name} ({h}) -> NOT_FOUND")
    except Exception as e:
        print(f"{name} ({h}) -> {e}")
