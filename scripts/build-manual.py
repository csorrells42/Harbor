"""Build the PDF from the same Markdown manual published on GitHub.

Usage: python scripts/build-manual.py [--root /path/to/documentation]
Requires Python 3.10+ and reportlab. No network access or external documents.
"""
from __future__ import annotations
import argparse
import hashlib
import html
import json
import re
import textwrap
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, PageTemplate, Paragraph,
    Spacer, PageBreak, Preformatted, LongTable, TableStyle, KeepTogether)
from reportlab.platypus.tableofcontents import TableOfContents
import reportlab

NAVY=colors.HexColor('#152b44')
TEAL=colors.HexColor('#087d86')
INK=colors.HexColor('#273746')
GRAY=colors.HexColor('#607082')
PAPER=colors.HexColor('#eef4f7')

def register_fonts():
    windows=Path('C:/Windows/Fonts')
    fallback=Path(reportlab.__file__).parent/'fonts'
    choices=[('Body',windows/'segoeui.ttf',fallback/'Vera.ttf'),
             ('Body-Bold',windows/'segoeuib.ttf',fallback/'VeraBd.ttf'),
             ('Body-Italic',windows/'segoeuii.ttf',fallback/'VeraIt.ttf'),
             ('Code',windows/'consola.ttf',fallback/'Vera.ttf')]
    for name,preferred,other in choices:
        pdfmetrics.registerFont(TTFont(name,str(preferred if preferred.exists() else other)))
    pdfmetrics.registerFontFamily('Body',normal='Body',bold='Body-Bold',italic='Body-Italic',boldItalic='Body-Bold')

def inline(value):
    held=[]
    def protect(s):
        held.append(s);return f'@@HARBOR{len(held)-1}@@'
    value=re.sub(r'`([^`]+)`',lambda m:protect('<font name="Code">'+html.escape(m[1])+'</font>'),value)
    value=html.escape(value)
    value=re.sub(r'\[([^\]]+)\]\(([^)]+)\)',lambda m:'<link href="'+(m[2][3:] if m[2].startswith('../') else m[2])+'" color="#087d86">'+m[1]+'</link>',value)
    value=re.sub(r'\*\*([^*]+)\*\*',r'<b>\1</b>',value)
    value=re.sub(r'(?<!\*)\*([^*]+)\*(?!\*)',r'<i>\1</i>',value)
    for i,s in enumerate(held):value=value.replace(f'@@HARBOR{i}@@',s)
    return value

def slug(s):
    return re.sub(r'[^\w\- ]','',s.lower()).replace(' ','-')

def styles():
    s=getSampleStyleSheet()
    s.add(ParagraphStyle('ManualBody',fontName='Body',fontSize=9.2,leading=14,textColor=INK,spaceAfter=7))
    s.add(ParagraphStyle('ManualBullet',parent=s['ManualBody'],leftIndent=13,firstLineIndent=-10,spaceAfter=5))
    s.add(ParagraphStyle('ManualH1',fontName='Body-Bold',fontSize=23,leading=29,textColor=NAVY,spaceAfter=17,keepWithNext=True))
    s.add(ParagraphStyle('ManualH2',fontName='Body-Bold',fontSize=13.5,leading=19,textColor=TEAL,spaceBefore=14,spaceAfter=8,keepWithNext=True))
    s.add(ParagraphStyle('ManualH3',fontName='Body-Bold',fontSize=10.5,leading=15,textColor=NAVY,spaceBefore=9,spaceAfter=5,keepWithNext=True))
    s.add(ParagraphStyle('ManualCell',parent=s['ManualBody'],fontSize=8.1,leading=11,spaceAfter=0,wordWrap='CJK'))
    s.add(ParagraphStyle('ManualCode',fontName='Code',fontSize=7.8,leading=11,textColor=INK,backColor=PAPER,borderPadding=10,spaceBefore=5,spaceAfter=12))
    s.add(ParagraphStyle('CoverTitle',fontName='Body-Bold',fontSize=44,leading=51,textColor=NAVY,spaceAfter=18))
    s.add(ParagraphStyle('CoverSub',fontName='Body',fontSize=18,leading=26,textColor=TEAL,spaceAfter=24))
    s.add(ParagraphStyle('CoverMeta',fontName='Body',fontSize=10.5,leading=17,textColor=GRAY,spaceAfter=10))
    return s

class ManualDoc(BaseDocTemplate):
    def __init__(self,path,meta):
        super().__init__(str(path),pagesize=(8.5*inch,11*inch),rightMargin=48,leftMargin=48,topMargin=50,bottomMargin=48,title='Harbor — Installation and Operations Manual',author='Christopher Sorrells (csorrells42) <clsorrells42@gmail.com>',subject='Source SHA-256: '+meta['sourceSha256'])
        self.meta=meta
        frame=Frame(self.leftMargin,self.bottomMargin,self.width,self.height,id='normal',leftPadding=0,rightPadding=0,topPadding=0,bottomPadding=0)
        self.addPageTemplates(PageTemplate(id='manual',frames=frame,onPage=self.decorate))
    def decorate(self,canvas,doc):
        canvas.saveState()
        if(doc.page>1):
            canvas.setStrokeColor(TEAL);canvas.setLineWidth(.6);canvas.line(48,758,564,758)
            canvas.setFont('Body',8);canvas.setFillColor(GRAY)
            canvas.drawString(48,766,'HARBOR  /  INSTALLATION & OPERATIONS')
            canvas.drawRightString(564,766,self.meta['edition'])
        canvas.setFont('Body',8);canvas.setFillColor(GRAY)
        canvas.drawString(48,28,'Local tools. One gateway. Your configuration.')
        canvas.drawRightString(564,28,str(doc.page))
        canvas.restoreState()
    def afterFlowable(self,f):
        if isinstance(f,Paragraph) and hasattr(f,'manual_heading'):
            level,title,anchor=f.manual_heading
            self.canv.bookmarkPage(anchor)
            self.canv.addOutlineEntry(title,anchor,level=level,closed=level>0)
            if level<=1:self.notify('TOCEntry',(level,title,self.page,anchor))

def markdown_story(source,s,width):
    story=[];lines=source.splitlines();i=0;first=True
    while i<len(lines):
        line=lines[i].rstrip();i+=1
        if not line or line.startswith('<!--'):continue
        if line.startswith('# '):continue
        if line.startswith('```'):
            code=[]
            while i<len(lines) and not lines[i].startswith('```'):
                code.extend(textwrap.wrap(lines[i],width=98,replace_whitespace=False,drop_whitespace=False,break_long_words=True,break_on_hyphens=False) or [''])
                i+=1
            i+=1;story.append(Preformatted('\n'.join(code),s['ManualCode']));continue
        if line.startswith('|'):
            rows=[line]
            while i<len(lines) and lines[i].startswith('|'):rows.append(lines[i]);i+=1
            data=[]
            for row in rows:
                cells=[c.strip() for c in row.strip('|').split('|')]
                if all(re.fullmatch(r'[:\- ]+',c) for c in cells):continue
                data.append([Paragraph(inline(c),s['ManualCell']) for c in cells])
            n=max(map(len,data));data=[r+[Paragraph('',s['ManualCell'])]*(n-len(r)) for r in data]
            widths=([width*.27,width*.73] if n==2 else [width/n]*n)
            table=LongTable(data,colWidths=widths,repeatRows=1,hAlign='LEFT',spaceBefore=5,spaceAfter=12)
            table.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),PAPER),('VALIGN',(0,0),(-1,-1),'TOP'),('LINEBELOW',(0,0),(-1,0),.8,TEAL),('LINEBELOW',(0,1),(-1,-1),.3,colors.HexColor('#d7e1e8')),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7),('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7)]));story.append(table);continue
        heading=re.match(r'^(#{2,4}) (.+)',line)
        if heading:
            level=len(heading[1])-2;title=heading[2]
            if level==0:
                if not first:story.append(PageBreak())
                first=False
            p=Paragraph(inline(title),s[['ManualH1','ManualH2','ManualH3'][level]])
            p.manual_heading=(level,title,slug(title));story.append(p);continue
        bullet=re.match(r'^(?:[-*] |\d+\. )(.+)',line)
        if bullet:
            prefix=line[:line.index(' ')]
            story.append(Paragraph(inline(('•' if prefix in ('-','*') else prefix)+' '+bullet[1]),s['ManualBullet']));continue
        if line.startswith('> '):
            story.append(Paragraph('<b>Note.</b> '+inline(line[2:]),s['ManualBody']));continue
        while i<len(lines) and lines[i].strip() and not re.match(r'^(#|\||```|[-*] |\d+\. |<!--|> )',lines[i]):
            line+=' '+lines[i].strip();i+=1
        story.append(Paragraph(inline(line),s['ManualBody']))
    return story

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]);args=parser.parse_args()
    root=args.root.resolve();source=root/'docs/HARBOR-MANUAL.md';meta=json.loads((root/'docs/manual-release.json').read_text(encoding='utf-8'));meta['sourceSha256']=hashlib.sha256(source.read_bytes()).hexdigest()
    register_fonts();s=styles();out=root/'HARBOR-MANUAL.pdf';doc=ManualDoc(out,meta)
    story=[Spacer(1,65),Paragraph('HARBOR',s['CoverTitle']),Paragraph('Installation &amp;<br/>Operations Manual',s['CoverSub']),Spacer(1,20),Paragraph('Quickstart · Connections · Configuration<br/>Tool delivery · Diagnostics · Maintenance<br/>Subsystems · Repositories · Recovery',s['CoverMeta']),Spacer(1,30),Paragraph('Christopher Sorrells (csorrells42)',s['CoverMeta']),Paragraph('<link href="mailto:clsorrells42@gmail.com" color="#087d86">clsorrells42@gmail.com</link>',s['CoverMeta']),Spacer(1,14),Paragraph(inline(meta['edition']),s['CoverMeta']),Paragraph(inline(meta['scope']),s['CoverMeta']),Paragraph(inline('Reviewed '+meta['reviewed']),s['CoverMeta']),Spacer(1,20),Paragraph('The complete operator reference for the Harbor desktop application and its Windows Portable toolbox. The same manual is available as searchable Markdown in the project repository.',s['CoverMeta']),PageBreak(),Paragraph('Contents',s['ManualH1'])]
    toc=TableOfContents();toc.levelStyles=[ParagraphStyle('TOC0',fontName='Body-Bold',fontSize=10,leading=15,textColor=NAVY,spaceBefore=8),ParagraphStyle('TOC1',fontName='Body',fontSize=8.5,leading=12,leftIndent=14,textColor=GRAY)]
    story.extend([toc,PageBreak()]);story.extend(markdown_story(source.read_text(encoding='utf-8'),s,doc.width))
    doc.multiBuild(story)
    print(json.dumps({'pdf':str(out),'bytes':out.stat().st_size,'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest()}))

if __name__=='__main__':main()
