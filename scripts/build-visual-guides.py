"""Build Harbor's explanatory workflow diagrams as PNG and editable SVG.

Requires reportlab and pypdfium2; run from any directory.
These diagrams explain workflows. They are not application screenshots or results.
"""
from pathlib import Path
import argparse, math, tempfile
from reportlab.graphics.shapes import Drawing, Rect, String, Line, Polygon
from reportlab.graphics import renderPDF, renderSVG
from reportlab.lib.colors import HexColor
from reportlab.pdfbase.pdfmetrics import stringWidth
import pypdfium2 as pdfium

W=1120
NAVY='#152b44'; TEAL='#087d86'; INK='#273746'; GRAY='#607082'
BORDER='#cbdbe4'; PALE='#eef5f8'; AQUA='#e4f3f2'; BLUE='#eaf0ff'; WHITE='#ffffff'

def wrapped(text,width,font,size):
    out=[]
    for paragraph in text.split('\n'):
        line=''
        for word in paragraph.split():
            candidate=(line+' '+word).strip()
            if line and stringWidth(candidate,font,size)>width:
                out.append(line);line=word
            else:line=candidate
        out.append(line)
    return out

class Guide:
    def __init__(self,height,title,subtitle):
        self.h=height;self.d=Drawing(W,height)
        self.d.add(Rect(0,0,W,height,fillColor=HexColor(WHITE),strokeColor=None))
        self.text(32,24,title,32,'Helvetica-Bold',NAVY,W-64)
        self.text(32,72,subtitle,20,'Helvetica',GRAY,W-64)
        self.d.add(Line(32,height-116,W-32,height-116,strokeColor=HexColor(TEAL),strokeWidth=2))
    def text(self,x,y,text,size=20,font='Helvetica',color=INK,width=1000,leading=None):
        leading=leading or size*1.28
        lines=wrapped(text,width,font,size)
        for i,line in enumerate(lines):
            self.d.add(String(x,self.h-y-size-i*leading,line,fontName=font,fontSize=size,fillColor=HexColor(color)))
        return len(lines)*leading
    def box(self,x,y,w,h,title,body='',fill=PALE,title_size=23,body_size=20):
        self.d.add(Rect(x,self.h-y-h,w,h,rx=12,ry=12,fillColor=HexColor(fill),strokeColor=HexColor(BORDER),strokeWidth=1.5))
        used=self.text(x+20,y+16,title,title_size,'Helvetica-Bold',NAVY,w-40)
        if body:used+=9+self.text(x+20,y+16+used+9,body,body_size,'Helvetica',INK,w-40)
        if used>h-27:raise ValueError(f'Overflow in {title}: {used:.1f} > {h-27}')
    def arrow(self,points,dashed=False,color=TEAL,head=True):
        for (x1,y1),(x2,y2) in zip(points,points[1:]):
            self.d.add(Line(x1,self.h-y1,x2,self.h-y2,strokeColor=HexColor(color),strokeWidth=2.8,strokeDashArray=[7,5] if dashed else None))
        if not head:return
        (x1,y1),(x2,y2)=points[-2:];angle=math.atan2(y2-y1,x2-x1);size=10
        coords=[x2,self.h-y2,x2-size*math.cos(angle-.5),self.h-(y2-size*math.sin(angle-.5)),x2-size*math.cos(angle+.5),self.h-(y2-size*math.sin(angle+.5))]
        self.d.add(Polygon(coords,fillColor=HexColor(color),strokeColor=HexColor(color)))
    def footer(self,y,text):
        self.d.add(Rect(32,self.h-y-72,W-64,72,rx=10,ry=10,fillColor=HexColor(AQUA),strokeColor=None))
        self.text(50,y+12,text,19,'Helvetica',NAVY,W-100)
    def save(self,folder,name):
        renderSVG.drawToFile(self.d,str(folder/(name+'.svg')))
        with tempfile.TemporaryDirectory(prefix='harbor-visual-') as tmp:
            path=Path(tmp)/'guide.pdf';renderPDF.drawToFile(self.d,str(path))
            pdf=pdfium.PdfDocument(str(path));page=pdf[0];bitmap=page.render(scale=1.6)
            bitmap.to_pil().save(folder/(name+'.png'));bitmap.close();page.close();pdf.close()


def quickstart(folder):
    g=Guide(670,'Your first working connection','Start with one client, a few tools and one checkable operation.')
    cards=[(32,150,'1  Launch Harbor','Use Start Harbor.vbs in the complete Portable folder.'),
           (407,150,'2  Review protections','This Server: review API key and Loopback only. Apply changes.'),
           (782,150,'3  Start needed tools','Start the child servers you need. Check their status.'),
           (782,382,'4  Copy configuration','Connections: select address and transport; copy configuration.'),
           (407,382,'5  Reconnect the client','Paste its MCP configuration. Reconnect; include the saved key when enabled.'),
           (32,382,'6  Verify an operation','Use a small task with an outcome you can inspect yourself.')]
    for x,y,t,b in cards:g.box(x,y,306,172,t,b,fill=AQUA if t.startswith('6') else PALE,body_size=20)
    for a,b in [(338,407),(713,782)]:g.arrow([(a,236),(b,236)])
    g.arrow([(935,322),(935,382)])
    for a,b in [(782,713),(407,338)]:g.arrow([(a,468),(b,468)])
    g.footer(588,'A running server or discovered tool is only a connection check. After one verified task, explore Tool Delivery and start Diagnostics explicitly when needed.')
    g.save(folder,'01-quickstart-path')


def portable(folder):
    g=Guide(750,'What travels with a Portable folder?','Quit and stop servers first. Keep the complete directory tree together.')
    g.d.add(Rect(32,g.h-480,1056,328,rx=14,ry=14,fillColor=HexColor(PALE),strokeColor=HexColor(BORDER),strokeWidth=1.5))
    g.text(56,170,'Harbor Portable folder',26,'Helvetica-Bold',NAVY)
    g.box(56,225,482,222,'Application and tools','application/\npackages/\nruntimes/\nsupport/',fill=WHITE)
    g.box(564,225,500,222,'Saved state and user content','data/: settings, credentials, workspaces, memory and Diagnostics.\nKeep maintenance records for recovery.',fill=AQUA)
    g.arrow([(286,480),(286,534)])
    g.box(56,534,482,120,'Destination folder','Copy or move the whole Portable tree.',fill=BLUE)
    g.box(564,534,500,120,'Review separately','External project paths, account stores and model services.',fill=WHITE)
    g.footer(668,'Private data and credentials travel with the folder. External locations and services do not. Review absolute paths and authentication after relocation.')
    g.save(folder,'02-portable-folder')


def architecture(folder):
    g=Guide(815,'How a tool request moves through Harbor','The desktop manages connections; the gateway routes tool calls.')
    g.box(377,145,366,111,'Harbor desktop UI','Settings and lifecycle controls',fill=BLUE)
    g.arrow([(560,256),(560,321)])
    g.text(578,275,'local IPC',17,'Helvetica',GRAY,120)
    g.box(32,315,275,158,'Native HTTP client','Uses the current gateway endpoint and saved key when enabled.',body_size=19)
    g.box(32,491,275,158,'Stdio-only client','Uses the Harbor stdio bridge to reach that HTTP gateway.',body_size=19)
    g.box(377,321,366,219,'Harbor Hub + gateway','Selected bind address\nBearer key when enabled\nTool catalog and routing\nShared child connections',fill=AQUA,body_size=20)
    g.arrow([(307,383),(377,383)])
    g.arrow([(307,559),(345,559),(345,488),(377,488)])
    g.box(813,315,275,155,'Managed servers','Stdio or HTTP/SSE. Harbor owns the processes it launches.',body_size=19)
    g.box(813,501,275,148,'External servers','HTTP/SSE. Lifecycle remains with their outside owner.',body_size=19)
    g.arrow([(743,386),(813,386)])
    g.arrow([(743,480),(778,480),(778,563),(813,563)])
    g.box(377,594,366,119,'Discovery workers','Optional search and Hybrid modes',fill=BLUE,body_size=20)
    g.arrow([(560,594),(560,540)],dashed=True)
    g.footer(730,'Responses return along the same route. Harbor proxies tools, not a chat model. Upstream state is shared; discovery modes do not create per-client permissions.')
    g.save(folder,'03-gateway-architecture')


def delivery(folder):
    g=Guide(770,'Discovery and execution are separate steps','Tool Delivery changes what a client sees and how it finds the tool to invoke.')
    g.box(32,150,500,153,'All tools','Receive the full tool definitions. Choose an exact tool name and valid arguments.',fill=BLUE)
    g.box(588,150,500,153,'Search / Hybrid','Query discovery. Read the returned names and input schemas before choosing a tool.',fill=AQUA)
    g.arrow([(282,303),(282,348),(560,348),(560,384)])
    g.arrow([(838,303),(838,348),(560,348)],head=False)
    g.box(210,384,700,118,'Invoke through the selected mode','Use its required call interface, tool name and arguments.')
    g.box(32,552,310,110,'Harbor routes','Match the namespaced tool.')
    g.box(405,552,310,110,'Upstream executes','The child server performs it.')
    g.box(778,552,310,110,'Client receives result','Inspect the actual outcome.')
    g.arrow([(342,607),(405,607)]);g.arrow([(715,607),(778,607)])
    g.arrow([(560,502),(560,522),(187,522),(187,552)])
    g.footer(683,'Discovery is not execution or a permission boundary. Code Mode can look up schemas and compose tool calls in Python; use the documented mode interface.')
    g.save(folder,'04-tool-delivery-flow')


def diagnostics(folder):
    g=Guide(870,'From trial evidence to a useful comparison','A campaign varies delivery settings on the installed harness and model pairing.')
    items=[('1  Verify Hermes + model','Confirm the actual configured pairing before testing.'),
           ('2  Build the test matrix','Delivery variants x tasks x repetitions, within time and resource limits.'),
           ('3  Run fresh trials','Use fresh Hermes sessions and private synthetic fixtures.'),
           ('4  Collect evidence','Acceptance, tool calls, fixture state, final response, elapsed time and resources.'),
           ('5  Check eligibility + grade','Apply the independent rubric; retain excluded trials visibly.')]
    for i,(title,body) in enumerate(items):
        y=145+i*124;g.box(32,y,581,114,title,body,fill=AQUA if i==4 else PALE,title_size=22,body_size=19)
        if i<4:g.arrow([(322,y+114),(322,y+124)])
    g.text(682,167,'Four comparison views',25,'Helvetica-Bold',NAVY,375)
    for i,(title,body) in enumerate([('Harbor configurations','Compare matched delivery setups'),('Models','Outcomes grouped by model'),('Harnesses','Outcomes grouped by harness'),('Combinations','Outcomes for each full pairing')]):
        g.box(682,218+i*126,406,105,title,body,fill=BLUE,title_size=23,body_size=19)
    g.arrow([(613,691),(650,691),(650,270),(682,270)])
    for y in [396,522,648]:g.arrow([(650,y),(682,y)])
    g.footer(781,'Compare matched tasks and coverage. More matched pairings are needed to rank models or harnesses. A completed run alone is not verified task success.')
    g.save(folder,'05-diagnostics-evidence')


def maintenance(folder):
    g=Guide(1060,'Maintenance: follow the final status','Pause work, read the outcome, then use the appropriate resume or restart path.')
    g.box(32,148,1056,92,'1  Finish work before maintenance','Finish or stop client tasks; finish or cancel Diagnostics explicitly.',fill=AQUA,title_size=22,body_size=20)
    g.arrow([(560,240),(560,255),(283,255),(283,273)])
    g.box(32,273,503,123,'2  Enter maintenance mode','Pause calls, suspend delivery workers and stop Harbor-owned child services.',title_size=22,body_size=19)
    g.box(585,273,503,123,'3  Choose an action','Update and build or Rebuild where available. Wait; read phase and log.',title_size=22,body_size=19)
    g.arrow([(535,335),(585,335)])
    g.arrow([(836,396),(836,435),(560,435),(560,477)])
    g.box(361,477,398,80,'4  Read the final status','',fill=AQUA,title_size=24)
    g.arrow([(361,517),(286,517),(286,600)]);g.arrow([(759,517),(837,517),(837,600)])
    g.box(32,600,503,180,'Component complete / current','Resume servers. Reconnect the client and check a representative operation.',fill=BLUE,title_size=22,body_size=21)
    g.box(585,600,503,180,'Harbor: restart-required','Quit and stop servers from the tray. Use Start Harbor; the launcher activates the verified app. Reconnect and check.',fill=BLUE,title_size=22,body_size=20)
    g.box(32,791,1056,150,'If something fails, follow the reported state','Current version retained: inspect the log, fix the cause and retry.\nActivated but metadata needs recovery: preserve records, then quit and restart.\nLauncher failure: inspect launch-error.txt and the named application path.',fill=PALE,title_size=23,body_size=19)
    g.footer(970,'One maintenance job runs at a time. Closing the window only hides Harbor. The current retention policy keeps no user rollback copy.')
    g.save(folder,'06-maintenance-lifecycle')


def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]);a=p.parse_args()
    folder=a.root.resolve()/'docs/images/guides';folder.mkdir(parents=True,exist_ok=True)
    for build in [quickstart,portable,architecture,delivery,diagnostics,maintenance]:build(folder)
    print('Built six workflow guides as PNG and SVG in '+str(folder))
if __name__=='__main__':main()
