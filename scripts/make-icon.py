from pathlib import Path
from PIL import Image, ImageDraw
root = Path(__file__).resolve().parent.parent
out = root / 'assets'
out.mkdir(exist_ok=True)
im = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.rounded_rectangle((12,12,500,500),radius=110,fill='#18191f',outline='#424451',width=8)
d.ellipse((208,88,304,184),outline='#ada7ff',width=21)
d.line((256,176,256,370),fill='#ada7ff',width=23)
d.line((174,225,338,225),fill='#ada7ff',width=23)
d.arc((119,184,393,407),0,180,fill='#ada7ff',width=23)
d.polygon([(119,280),(97,332),(154,311)],fill='#ada7ff')
d.polygon([(393,280),(415,332),(358,311)],fill='#ada7ff')
d.polygon([(256,409),(224,375),(288,375)],fill='#ada7ff')
im.save(out/'icon.png')
im.save(out/'icon.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
print('Generated assets/icon.png and assets/icon.ico')
