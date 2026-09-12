import base64, io, json, resource, sys, warnings
resource.setrlimit(resource.RLIMIT_CPU,(8,8))
resource.setrlimit(resource.RLIMIT_AS,(768*1024**2,768*1024**2))
from PIL import Image, ImageOps
Image.MAX_IMAGE_PIXELS=12_000_000
warnings.simplefilter('error',Image.DecompressionBombWarning)
try:
    raw=base64.b64decode(sys.stdin.read(2_800_000),validate=True)
    image=Image.open(io.BytesIO(raw))
    if image.format not in ('PNG','JPEG'): raise ValueError('unsupported image')
    image=ImageOps.exif_transpose(image).convert('RGB')
    image.thumbnail((1600,1600))
    output=io.BytesIO();image.save(output,format='JPEG',quality=90)
    print(json.dumps({'image':base64.b64encode(output.getvalue()).decode()}))
except Exception: print(json.dumps({'error':'Invalid image.'}))
