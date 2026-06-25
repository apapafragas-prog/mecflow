#!/usr/bin/env python3
import sys, json, io
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

def run(data):
    client=data.get("client","Client"); year=data.get("year","FY26")
    inv=data.get("inv",[]); sub=data.get("sub",[])
    lab=data.get("lab",{}); acc=data.get("acc",{})
    status=data.get("status","draft")
    submitted_by=data.get("submittedBy",""); submitted_at=data.get("submittedAt","")
    MONTHS=["2026-01","2026-02","2026-03","2026-04","2026-05","2026-06","2026-07","2026-08","2026-09","2026-10","2026-11","2026-12"]
    ML={"2026-01":"Jan-26","2026-02":"Feb-26","2026-03":"Mar-26","2026-04":"Apr-26","2026-05":"May-26","2026-06":"Jun-26","2026-07":"Jul-26","2026-08":"Aug-26","2026-09":"Sep-26","2026-10":"Oct-26","2026-11":"Nov-26","2026-12":"Dec-26"}
    LAB_ROWS=[{"k":"onsite","l":"CBRE On site team"},{"k":"regional","l":"Regional Cost"},{"k":"it","l":"IT Cost"},{"k":"local","l":"Local Support"},{"k":"sga","l":"SG&A"},{"k":"other","l":"Other items"}]
    G="003F2D";W="FFFFFF";CT="C0D4CB";DG="435254";WT="EFECD2";MB="032842"
    def fill(h): return PatternFill("solid",fgColor=h)
    def fnt(sz=9,bold=False,color=DG,italic=False): return Font(name="Tahoma",size=sz,bold=bold,color=color,italic=italic)
    def hfnt(sz=9): return Font(name="Tahoma",size=sz,bold=True,color=W)
    thin=Side(style="thin",color="CAD1D3")
    def bdr(): return Border(top=thin,bottom=thin,left=thin,right=thin)
    FMT_EUR='#,##0.00;[Red](#,##0.00);"-"'; FMT_PCT='0.0%;[Red](0.0%);"-"'
    def title_row(ws,text,cols,row=1):
        ws.merge_cells(start_row=row,start_column=1,end_row=row,end_column=cols)
        c=ws.cell(row,1,text); c.font=Font(name="Times New Roman",size=12,bold=True,color=W)
        c.fill=fill(G); c.alignment=Alignment(horizontal="left",vertical="center",indent=2)
        ws.row_dimensions[row].height=34; ws.sheet_view.showGridLines=False
    wb=Workbook()
    # ── TAB 1: SUMMARY
    ws1=wb.active; ws1.title="Summary"
    title_row(ws1,f"CBRE Hellas  |  {client}  |  {year}  Monthly Reporting",14)
    tot_rev=sum(i.get("amt",0) or 0 for i in inv)
    tot_lab=sum(sum(v for v in (lab.get(m) or {}).values() if isinstance(v,(int,float))) for m in MONTHS)
    tot_sub=sum(i.get("amt",0) or 0 for i in sub)
    tot_cost=tot_lab+tot_sub; tot_gm=tot_rev-tot_cost
    tot_gm_pct=tot_gm/tot_rev if tot_rev else None
    kpis=[("Total Revenue (YTD)",tot_rev,FMT_EUR,1),("Total Cost (YTD)",tot_cost,FMT_EUR,4),("GM € (YTD)",tot_gm,FMT_EUR,7),("GM % (YTD)",tot_gm_pct,FMT_PCT,10)]
    for lbl,val,fmt,col in kpis:
        ws1.merge_cells(start_row=3,start_column=col,end_row=3,end_column=col+2)
        ws1.merge_cells(start_row=4,start_column=col,end_row=4,end_column=col+2)
        ws1.merge_cells(start_row=5,start_column=col,end_row=5,end_column=col+2)
        c1=ws1.cell(3,col,lbl); c1.font=hfnt(); c1.fill=fill(G); c1.alignment=Alignment(horizontal="center",vertical="center")
        c2=ws1.cell(4,col,val); c2.font=Font(name="Tahoma",size=18,bold=True,color=G); c2.number_format=fmt; c2.alignment=Alignment(horizontal="center",vertical="center")
        c3=ws1.cell(5,col,"YTD"); c3.font=fnt(8,italic=True); c3.fill=fill(CT); c3.alignment=Alignment(horizontal="center")
    ws1.row_dimensions[3].height=22; ws1.row_dimensions[4].height=38; ws1.row_dimensions[5].height=16
    ws1.merge_cells(start_row=7,start_column=1,end_row=7,end_column=14)
    th=ws1.cell(7,1,"MONTHLY P&L TREND"); th.font=hfnt(); th.fill=fill(G); th.alignment=Alignment(horizontal="left",vertical="center",indent=1)
    ws1.row_dimensions[7].height=20
    for ci,h in enumerate([""]+[ML[m] for m in MONTHS]+["YTD"],1):
        c=ws1.cell(8,ci,h); c.font=hfnt(8); c.fill=fill(MB); c.alignment=Alignment(horizontal="center"); c.border=bdr()
    ws1.row_dimensions[8].height=18
    trend=[("Revenue",{m:sum(i.get("amt",0) or 0 for i in inv if i.get("month")==m) for m in MONTHS}),("Sub Cost",{m:sum(i.get("amt",0) or 0 for i in sub if i.get("month")==m) for m in MONTHS}),("Labour",{m:sum(v for v in (lab.get(m) or {}).values() if isinstance(v,(int,float))) for m in MONTHS}),("GM €",{m:sum(i.get("amt",0) or 0 for i in inv if i.get("month")==m)-sum(i.get("amt",0) or 0 for i in sub if i.get("month")==m)-sum(v for v in (lab.get(m) or {}).values() if isinstance(v,(int,float))) for m in MONTHS})]
    for ri,(lbl,md) in enumerate(trend,9):
        bg=CT if ri%2==0 else W
        c=ws1.cell(ri,1,lbl); c.font=fnt(9,bold=True); c.fill=fill(bg); c.border=bdr()
        for ci,m in enumerate(MONTHS,2):
            v=md.get(m,0); c=ws1.cell(ri,ci,v if v else None)
            c.font=fnt(); c.fill=fill(bg); c.number_format=FMT_EUR; c.alignment=Alignment(horizontal="right"); c.border=bdr()
        ytd=sum(md.values()); c=ws1.cell(ri,14,ytd if ytd else None)
        c.font=fnt(9,bold=True,color=G); c.fill=fill(bg); c.number_format=FMT_EUR; c.alignment=Alignment(horizontal="right"); c.border=bdr()
        ws1.row_dimensions[ri].height=16
    ws1.column_dimensions["A"].width=14
    for c in range(2,16): ws1.column_dimensions[get_column_letter(c)].width=10
    ws1.sheet_properties.tabColor=G
    # ── TAB 2: SUB INVOICES
    ws2=wb.create_sheet("Sub Invoices")
    title_row(ws2,f"CBRE Hellas  |  {client}  |  Sub Invoices Register — {year}",17)
    sh=["#","Site","Month","Cost Category","Supplier","Service","Description","Invoice No","Date","Net €","VAT €","Total €","Fee %","CBRE Fee €","CBRE Billing €","Act/Acc","Comments"]
    for ci,h in enumerate(sh,1):
        c=ws2.cell(2,ci,h); c.font=hfnt(); c.fill=fill(G); c.alignment=Alignment(horizontal="center",vertical="center",wrap_text=True); c.border=bdr()
    ws2.row_dimensions[2].height=28
    for ri,r in enumerate(sub,3):
        bg=CT if ri%2==0 else W; ws2.row_dimensions[ri].height=16
        amt=r.get("amt",0) or 0
        vals=[ri-2,r.get("site",""),ML.get(r.get("month",""),""),r.get("cat",""),r.get("supplier",""),r.get("svc_cat",""),r.get("svc_desc",""),r.get("inv_no",""),r.get("date",""),amt,round(amt*0.24,2),round(amt*1.24,2),0.055,round(amt*0.055,2),round(amt*1.055,2),r.get("act_acc",""),r.get("comments","")]
        for ci,v in enumerate(vals,1):
            c=ws2.cell(ri,ci,v); c.font=fnt(); c.fill=fill(bg); c.border=bdr()
            if ci in [10,11,12,14,15]: c.number_format=FMT_EUR; c.alignment=Alignment(horizontal="right")
            if ci==13: c.number_format=FMT_PCT; c.alignment=Alignment(horizontal="center")
    tr2=len(sub)+3; ws2.row_dimensions[tr2].height=20
    for c in range(1,18): ws2.cell(tr2,c).fill=fill(G); ws2.cell(tr2,c).border=bdr()
    ws2.cell(tr2,1,"TOTAL").font=hfnt()
    for ci,v in [(10,sum(i.get("amt",0) or 0 for i in sub)),(11,sum(round((i.get("amt",0) or 0)*0.24,2) for i in sub)),(12,sum(round((i.get("amt",0) or 0)*1.24,2) for i in sub)),(14,sum(round((i.get("amt",0) or 0)*0.055,2) for i in sub)),(15,sum(round((i.get("amt",0) or 0)*1.055,2) for i in sub))]:
        ws2.cell(tr2,ci,v).font=hfnt(); ws2.cell(tr2,ci).fill=fill(G); ws2.cell(tr2,ci).number_format=FMT_EUR; ws2.cell(tr2,ci).alignment=Alignment(horizontal="right"); ws2.cell(tr2,ci).border=bdr()
    for i,w in enumerate([4,8,8,24,28,14,30,14,11,11,10,10,7,11,11,8,20],1): ws2.column_dimensions[get_column_letter(i)].width=w
    ws2.sheet_properties.tabColor=DG
    # ── TAB 3: CBRE INVOICES
    ws3=wb.create_sheet("CBRE Invoices")
    title_row(ws3,f"CBRE Hellas  |  {client}  |  Revenue Invoices — {year}",12)
    ih=["#","Site","Month","Revenue Category","Net €","VAT €","Total €","Invoice No","Date","Comments","Act/Acc","PO No"]
    for ci,h in enumerate(ih,1):
        c=ws3.cell(2,ci,h); c.font=hfnt(); c.fill=fill(G); c.alignment=Alignment(horizontal="center",vertical="center"); c.border=bdr()
    ws3.row_dimensions[2].height=24
    for ri,r in enumerate(inv,3):
        bg=CT if ri%2==0 else W; ws3.row_dimensions[ri].height=16; amt=r.get("amt",0) or 0
        vals=[ri-2,r.get("site",""),ML.get(r.get("month",""),""),r.get("cat",""),amt,round(amt*0.24,2),round(amt*1.24,2),r.get("inv_no",""),r.get("date",""),r.get("comments",""),r.get("act_acc",""),r.get("po_no","")]
        for ci,v in enumerate(vals,1):
            c=ws3.cell(ri,ci,v); c.font=fnt(); c.fill=fill(bg); c.border=bdr()
            if ci in [5,6,7]: c.number_format=FMT_EUR; c.alignment=Alignment(horizontal="right")
    tr3=len(inv)+3; ws3.row_dimensions[tr3].height=20
    for c in range(1,13): ws3.cell(tr3,c).fill=fill(G); ws3.cell(tr3,c).border=bdr()
    ws3.cell(tr3,1,"TOTAL").font=hfnt()
    for ci,v in [(5,sum(i.get("amt",0) or 0 for i in inv)),(6,sum(round((i.get("amt",0) or 0)*0.24,2) for i in inv)),(7,sum(round((i.get("amt",0) or 0)*1.24,2) for i in inv))]:
        ws3.cell(tr3,ci,v).font=hfnt(); ws3.cell(tr3,ci).fill=fill(G); ws3.cell(tr3,ci).number_format=FMT_EUR; ws3.cell(tr3,ci).alignment=Alignment(horizontal="right"); ws3.cell(tr3,ci).border=bdr()
    for i,w in enumerate([4,8,8,30,12,10,10,16,11,28,8,12],1): ws3.column_dimensions[get_column_letter(i)].width=w
    ws3.sheet_properties.tabColor="538184"
    # ── TAB 4: P&L REPORT
    ws4=wb.create_sheet("P&L Report")
    ws4.sheet_view.showGridLines=False
    ws4.merge_cells(start_row=1,start_column=1,end_row=1,end_column=16)
    c=ws4.cell(1,1,f"CBRE Hellas  |  {client}  |  {year}  Profit & Loss (EUR)")
    c.font=Font(name="Times New Roman",size=12,bold=True,color=W); c.fill=fill(G); c.alignment=Alignment(horizontal="left",vertical="center",indent=2); ws4.row_dimensions[1].height=36
    ws4.cell(2,1,"Line Item").font=hfnt(); ws4.cell(2,1).fill=fill(G); ws4.cell(2,1).alignment=Alignment(horizontal="left",vertical="center",indent=1); ws4.cell(2,1).border=bdr()
    ws4.cell(2,2,"Ref").font=hfnt(); ws4.cell(2,2).fill=fill(G); ws4.cell(2,2).alignment=Alignment(horizontal="center"); ws4.cell(2,2).border=bdr()
    for ci,m in enumerate(MONTHS,3):
        c=ws4.cell(2,ci,ML[m]); c.font=hfnt(); c.fill=fill(G); c.alignment=Alignment(horizontal="center"); c.border=bdr()
    ws4.cell(2,15,"YTD").font=hfnt(); ws4.cell(2,15).fill=fill(G); ws4.cell(2,15).alignment=Alignment(horizontal="center"); ws4.cell(2,15).border=bdr()
    ws4.cell(2,16,"Budget").font=hfnt(); ws4.cell(2,16).fill=fill(G); ws4.cell(2,16).alignment=Alignment(horizontal="center"); ws4.cell(2,16).border=bdr()
    ws4.row_dimensions[2].height=22
    rev_core={m:sum(i.get("amt",0) or 0 for i in inv if i.get("month")==m and "Core" in (i.get("cat","") or "")) for m in MONTHS}
    rev_ew={m:sum(i.get("amt",0) or 0 for i in inv if i.get("month")==m and "Extra" in (i.get("cat","") or "")) for m in MONTHS}
    rev_pjm={m:sum(i.get("amt",0) or 0 for i in inv if i.get("month")==m and "PJM" in (i.get("cat","") or "")) for m in MONTHS}
    rev_tot={m:rev_core[m]+rev_ew[m]+rev_pjm[m] for m in MONTHS}
    lab_tot={m:sum(v for v in (lab.get(m) or {}).values() if isinstance(v,(int,float))) for m in MONTHS}
    sub_core={m:sum(i.get("amt",0) or 0 for i in sub if i.get("month")==m) for m in MONTHS}
    sub_tot={m:sub_core[m] for m in MONTHS}
    tot_c={m:lab_tot[m]+sub_tot[m] for m in MONTHS}
    gm={m:rev_tot[m]-tot_c[m] for m in MONTHS}
    gm_pct={m:(gm[m]/rev_tot[m] if rev_tot[m] else None) for m in MONTHS}
    cur=3
    def prow(ws,row,label,mvals,rtype="data",ref=""):
        ws.row_dimensions[row].height=5 if rtype=="spacer" else 20 if rtype=="section" else 18
        if rtype=="spacer": return
        if rtype=="section":
            ws.merge_cells(start_row=row,start_column=1,end_row=row,end_column=2)
            c=ws.cell(row,1,label); c.font=fnt(9,bold=True,color=W)
            for cc in range(1,17): ws.cell(row,cc).fill=fill(MB); ws.cell(row,cc).border=bdr()
            return
        bg=WT if rtype in("total","grand_total") else (CT if row%2==0 else W)
        is_tot=rtype in("total","grand_total"); is_pct=rtype=="pct"
        c=ws.cell(row,1,label); c.font=fnt(9,bold=is_tot); c.fill=fill(bg); c.alignment=Alignment(horizontal="left",indent=1 if is_tot else 2); c.border=bdr()
        ws.cell(row,2,ref).font=fnt(9,italic=True,color="999999"); ws.cell(row,2).fill=fill(bg); ws.cell(row,2).border=bdr()
        ytd=0
        for ci,m in enumerate(MONTHS,3):
            v=mvals.get(m,0); c=ws.cell(row,ci,v if v else None)
            c.number_format=FMT_PCT if is_pct else FMT_EUR; c.fill=fill(bg); c.border=bdr()
            c.alignment=Alignment(horizontal="right"); c.font=fnt(9,bold=is_tot,italic=is_pct); ytd+=v or 0
        ytdc=ws.cell(row,15,ytd if ytd else None); ytdc.number_format=FMT_PCT if is_pct else FMT_EUR
        ytdc.fill=fill(bg); ytdc.border=bdr(); ytdc.alignment=Alignment(horizontal="right"); ytdc.font=fnt(9,bold=True,color=G if not is_tot else DG)
        ws.cell(row,16).fill=fill(bg); ws.cell(row,16).border=bdr()
    plines=[("REVENUE",None,"section",None),("CLIENT REVENUE - FM Core","rev_core","data",rev_core),("CLIENT REVENUE - FM Extra Works","rev_ew","data",rev_ew),("CLIENT REVENUE - PJMs","rev_pjm","data",rev_pjm),("Total Sales / Revenue","","total",rev_tot),(None,None,"spacer",None),("LABOUR COST",None,"section",None),("Labour Cost - FM Core","lab","data",lab_tot),("Labour Cost - FM Extra Works","","data",{m:0 for m in MONTHS}),("Total Labour Cost","","total",lab_tot),(None,None,"spacer",None),("SUBCONTRACTOR COST",None,"section",None),("CLIENT Sub cost - FM Core","sub","data",sub_core),("CLIENT Sub cost - FM Extra Works","","data",{m:0 for m in MONTHS}),("Total Subcontractor","","total",sub_tot),(None,None,"spacer",None),("TOTAL COST","tc","grand_total",tot_c),(None,None,"spacer",None),("GM — GROSS MARGIN",None,"section",None),("GM - Total €","gm","data",gm),("GM - Total %","gm_pct","pct",gm_pct),("GM - FM Core €","gm_core","data",{m:rev_core[m]-lab_tot[m]-sub_core[m] for m in MONTHS})]
    for line in plines:
        prow(ws4,cur,line[0],line[3] or {},line[2],line[1] or ""); cur+=1
    ws4.column_dimensions["A"].width=32; ws4.column_dimensions["B"].width=8
    for i in range(3,17): ws4.column_dimensions[get_column_letter(i)].width=11
    ws4.freeze_panes="C3"; ws4.sheet_properties.tabColor=G
    # ── TAB 5: LABOUR COST
    ws5=wb.create_sheet("Labour Cost")
    title_row(ws5,f"CBRE Hellas  |  {client}  |  Labour Cost — {year}",15)
    am5=[m for m in MONTHS if lab.get(m) and any(isinstance(v,(int,float)) and v>0 for v in lab[m].values())]
    if not am5: am5=MONTHS[:4]
    lh=["Category","FTEs"]+[ML[m] for m in am5]+["YTD Total"]
    for ci,h in enumerate(lh,1):
        c=ws5.cell(2,ci,h); c.font=hfnt(); c.fill=fill(G); c.alignment=Alignment(horizontal="center" if ci>1 else "left",vertical="center"); c.border=bdr()
    ws5.row_dimensions[2].height=24
    for ri,r in enumerate(LAB_ROWS,3):
        bg=CT if ri%2==0 else W; ws5.row_dimensions[ri].height=16; ytd5=0
        ws5.cell(ri,1,r["l"]).font=fnt(9,bold=True); ws5.cell(ri,1).fill=fill(bg); ws5.cell(ri,1).border=bdr()
        ws5.cell(ri,2).fill=fill(bg); ws5.cell(ri,2).border=bdr()
        for ci,m in enumerate(am5,3):
            v=float(lab.get(m,{}).get(r["k"],0) or 0); c=ws5.cell(ri,ci,v if v else None)
            c.font=fnt(); c.fill=fill(bg); c.number_format=FMT_EUR; c.alignment=Alignment(horizontal="right"); c.border=bdr(); ytd5+=v
        c=ws5.cell(ri,len(am5)+3,ytd5 if ytd5 else None); c.font=fnt(9,bold=True,color=G); c.number_format=FMT_EUR; c.alignment=Alignment(horizontal="right"); c.fill=fill(bg); c.border=bdr()
    sr5=len(LAB_ROWS)+3; ws5.row_dimensions[sr5].height=20
    for c in range(1,len(am5)+4): ws5.cell(sr5,c).fill=fill(WT); ws5.cell(sr5,c).border=bdr()
    ws5.cell(sr5,1,"SUM").font=fnt(9,bold=True)
    for ci in range(3,len(am5)+4):
        m=am5[ci-3] if ci-3<len(am5) else None
        v=sum(float(lab.get(m,{}).get(r["k"],0) or 0) for r in LAB_ROWS) if m else sum(sum(float(lab.get(mm,{}).get(r["k"],0) or 0) for r in LAB_ROWS) for mm in am5)
        ws5.cell(sr5,ci,v if v else None).font=fnt(9,bold=True); ws5.cell(sr5,ci).number_format=FMT_EUR; ws5.cell(sr5,ci).fill=fill(WT); ws5.cell(sr5,ci).alignment=Alignment(horizontal="right"); ws5.cell(sr5,ci).border=bdr()
    ws5.column_dimensions["A"].width=22; ws5.column_dimensions["B"].width=6
    for i in range(3,len(am5)+4): ws5.column_dimensions[get_column_letter(i)].width=11
    ws5.sheet_properties.tabColor=MB
    # ── TAB 6: ACCRUALS
    ws6=wb.create_sheet("Accruals")
    title_row(ws6,f"CBRE Hellas  |  {client}  |  Accruals — {year}",16)
    am6=[m for m in MONTHS if acc.get(m) and any(isinstance(v,(int,float)) and v!=0 for v in acc[m].values())]
    if not am6: am6=MONTHS[:4]
    ah=["Line","Open Bal"]+[ML[m] for m in am6]+["Closing"]
    for ci,h in enumerate(ah,1):
        c=ws6.cell(2,ci,h); c.font=hfnt(); c.fill=fill(G); c.alignment=Alignment(horizontal="center"); c.border=bdr()
    ws6.row_dimensions[2].height=24
    ws6.merge_cells(start_row=3,start_column=1,end_row=3,end_column=len(ah))
    c=ws6.cell(3,1,"UNBILLED/UNEARNED REVENUE (UBR/UER)"); c.font=fnt(9,bold=True,color=W); c.fill=fill(MB); c.alignment=Alignment(horizontal="left",indent=1); ws6.row_dimensions[3].height=20
    for cc in range(2,len(ah)+1): ws6.cell(3,cc).fill=fill(MB)
    for ri,lbl in enumerate(["UBR - FM Core","UBR - FM Extra Works","UBR - PJM","TOTAL UBR/UER"],4):
        is_tot=lbl.startswith("TOTAL"); bg=WT if is_tot else (CT if ri%2==0 else W)
        ws6.row_dimensions[ri].height=18; ws6.cell(ri,1,lbl).font=fnt(9,bold=is_tot)
        for cc in range(1,len(ah)+1): ws6.cell(ri,cc).fill=fill(bg); ws6.cell(ri,cc).border=bdr()
    ea=9; ws6.row_dimensions[ea-1].height=6
    ws6.merge_cells(start_row=ea,start_column=1,end_row=ea,end_column=len(ah))
    c=ws6.cell(ea,1,"EXPENSE ACCRUALS"); c.font=fnt(9,bold=True,color=W); c.fill=fill(MB); c.alignment=Alignment(horizontal="left",indent=1); ws6.row_dimensions[ea].height=20
    for cc in range(2,len(ah)+1): ws6.cell(ea,cc).fill=fill(MB)
    for ri2,lbl in enumerate(["Sub Cost Accrual - FM Core","Sub Cost Accrual - FM Extra Works","TOTAL EXPENSE"],ea+1):
        is_tot=lbl.startswith("TOTAL"); bg=WT if is_tot else (CT if ri2%2==0 else W)
        ws6.row_dimensions[ri2].height=18; ws6.cell(ri2,1,lbl).font=fnt(9,bold=is_tot)
        for cc in range(1,len(ah)+1): ws6.cell(ri2,cc).fill=fill(bg); ws6.cell(ri2,cc).border=bdr()
    ws6.column_dimensions["A"].width=28; ws6.column_dimensions["B"].width=10
    for i in range(3,len(ah)+2): ws6.column_dimensions[get_column_letter(i)].width=11
    ws6.sheet_properties.tabColor="7F8480"
    # ── TAB 7: MEC CHECKLIST
    ws7=wb.create_sheet("MEC Checklist")
    title_row(ws7,f"CBRE Hellas  |  {client}  |  Month-End Close Checklist — {year}",10)
    mh=["#","Month","Sub Invoices","CBRE Invoice","Labour","Accruals","Status","Submitted By","Submitted Date","Notes"]
    for ci,h in enumerate(mh,1):
        c=ws7.cell(2,ci,h); c.font=hfnt(); c.fill=fill(G); c.alignment=Alignment(horizontal="center"); c.border=bdr()
    ws7.row_dimensions[2].height=24
    sc2={"✅ Submitted":"C8E6C9","✅ Approved":"A5D6A7","🔄 In Review":"FFF9C4","⬜ Draft":"ECEFF1","❌ Rejected":"FFCDD2"}
    for ri,m in enumerate(MONTHS,3):
        bg=CT if ri%2==0 else W; ws7.row_dimensions[ri].height=18
        hs2=any(i.get("month")==m for i in sub); hi=any(i.get("month")==m for i in inv)
        hl=bool(lab.get(m) and any(isinstance(v,(int,float)) and v>0 for v in lab[m].values()))
        ha=bool(acc.get(m) and any(isinstance(v,(int,float)) and v!=0 for v in acc[m].values()))
        sl={"draft":"⬜ Draft","submitted":"✅ Submitted","approved":"✅ Approved","rejected":"❌ Rejected"}.get(status,"⬜ Draft")
        rd=[ri-2,ML[m],"✅ Done" if hs2 else "⬜ Pending","✅ Done" if hi else "⬜ Pending","✅ Done" if hl else "⬜ Pending","✅ Done" if ha else "⬜ Pending",sl,submitted_by if status in["submitted","approved"] else "",submitted_at if status in["submitted","approved"] else "",""]
        for ci,v in enumerate(rd,1):
            c=ws7.cell(ri,ci,v); c.font=fnt(9,bold=(ci==7)); c.border=bdr()
            c.alignment=Alignment(horizontal="center" if ci>1 else "left")
            c.fill=fill(sc2.get(v,bg) if ci==7 else bg)
    for i,w in enumerate([4,8,14,14,14,14,16,16,14,24],1): ws7.column_dimensions[get_column_letter(i)].width=w
    ws7.sheet_properties.tabColor="17E88F"
    buf=io.BytesIO(); wb.save(buf); return buf.getvalue()

def run_consolidated(data):
    year = data.get("year","FY26")
    clients = data.get("clients",[])
    MONTHS=["2026-01","2026-02","2026-03","2026-04","2026-05","2026-06","2026-07","2026-08","2026-09","2026-10","2026-11","2026-12"]
    ML={"2026-01":"Jan-26","2026-02":"Feb-26","2026-03":"Mar-26","2026-04":"Apr-26","2026-05":"May-26","2026-06":"Jun-26","2026-07":"Jul-26","2026-08":"Aug-26","2026-09":"Sep-26","2026-10":"Oct-26","2026-11":"Nov-26","2026-12":"Dec-26"}
    G="003F2D";W="FFFFFF";CT="C0D4CB";DG="435254";WT="EFECD2";MB="032842";NR="AD2A2A"
    from openpyxl import Workbook
    from openpyxl.styles import Font,PatternFill,Alignment,Border,Side
    from openpyxl.utils import get_column_letter
    import io
    def fill(h): return PatternFill("solid",fgColor=h)
    def fnt(sz=9,bold=False,color=DG,italic=False): return Font(name="Tahoma",size=sz,bold=bold,color=color,italic=italic)
    def hfnt(sz=9): return Font(name="Tahoma",size=sz,bold=True,color=W)
    thin=Side(style="thin",color="CAD1D3")
    def bdr(): return Border(top=thin,bottom=thin,left=thin,right=thin)
    FMT_EUR='#,##0.00;[Red](#,##0.00);"-"'; FMT_PCT='0.0%;[Red](0.0%);"-"'
    def title_row(ws,text,cols,row=1):
        ws.merge_cells(start_row=row,start_column=1,end_row=row,end_column=cols)
        c=ws.cell(row,1,text); c.font=Font(name="Times New Roman",size=12,bold=True,color=W)
        c.fill=fill(G); c.alignment=Alignment(horizontal="left",vertical="center",indent=2)
        ws.row_dimensions[row].height=34; ws.sheet_view.showGridLines=False

    # Aggregate data across all clients
    def agg_rev(m): return sum(sum(i.get("amt",0) or 0 for i in c.get("inv",[]) if i.get("month")==m) for c in clients)
    def agg_sub(m): return sum(sum(i.get("amt",0) or 0 for i in c.get("sub",[]) if i.get("month")==m) for c in clients)
    def agg_lab(m): return sum(sum(v for v in (c.get("lab",{}).get(m) or {}).values() if isinstance(v,(int,float))) for c in clients)
    def agg_gm(m): return agg_rev(m)-agg_sub(m)-agg_lab(m)

    wb=Workbook()

    # ── TAB 1: COMPANY SUMMARY
    ws1=wb.active; ws1.title="Company Summary"
    title_row(ws1,f"CBRE Hellas  |  All Accounts  |  {year}  Consolidated Reporting",16)
    ws1.merge_cells(start_row=2,start_column=1,end_row=2,end_column=16)
    c=ws1.cell(2,1,f"Total clients: {len(clients)}  |  Generated: {__import__('datetime').datetime.now().strftime('%d/%m/%Y')}  |  GWS Continental Europe")
    c.font=Font(name="Tahoma",size=9,color=W,italic=True); c.fill=fill(MB)
    c.alignment=Alignment(horizontal="left",vertical="center",indent=2); ws1.row_dimensions[2].height=18

    tot_rev=sum(agg_rev(m) for m in MONTHS); tot_sub=sum(agg_sub(m) for m in MONTHS)
    tot_lab=sum(agg_lab(m) for m in MONTHS); tot_cost=tot_sub+tot_lab; tot_gm=tot_rev-tot_cost
    tot_gm_pct=tot_gm/tot_rev if tot_rev else None
    kpis=[("Total Revenue",tot_rev,FMT_EUR,1),("Total Cost",tot_cost,FMT_EUR,4),("GM €",tot_gm,FMT_EUR,7),("GM %",tot_gm_pct,FMT_PCT,10)]
    for lbl,val,fmt,col in kpis:
        ws1.merge_cells(start_row=4,start_column=col,end_row=4,end_column=col+2)
        ws1.merge_cells(start_row=5,start_column=col,end_row=5,end_column=col+2)
        ws1.merge_cells(start_row=6,start_column=col,end_row=6,end_column=col+2)
        c1=ws1.cell(4,col,lbl); c1.font=hfnt(); c1.fill=fill(G); c1.alignment=Alignment(horizontal="center",vertical="center")
        c2=ws1.cell(5,col,val); c2.font=Font(name="Tahoma",size=18,bold=True,color=G); c2.number_format=fmt; c2.alignment=Alignment(horizontal="center",vertical="center")
        c3=ws1.cell(6,col,"YTD FY26"); c3.font=fnt(8,italic=True); c3.fill=fill(CT); c3.alignment=Alignment(horizontal="center")
    ws1.row_dimensions[4].height=22; ws1.row_dimensions[5].height=38; ws1.row_dimensions[6].height=16

    # Monthly trend
    ws1.merge_cells(start_row=8,start_column=1,end_row=8,end_column=14)
    ws1.cell(8,1,"MONTHLY CONSOLIDATED TREND").font=hfnt(); ws1.cell(8,1).fill=fill(G)
    ws1.cell(8,1).alignment=Alignment(horizontal="left",vertical="center",indent=1); ws1.row_dimensions[8].height=20
    for ci,h in enumerate([""]+[ML[m] for m in MONTHS]+["YTD"],1):
        c=ws1.cell(9,ci,h); c.font=hfnt(8); c.fill=fill(MB); c.alignment=Alignment(horizontal="center"); c.border=bdr()
    ws1.row_dimensions[9].height=18
    for ri,(lbl,fn) in enumerate([("Revenue",agg_rev),("Sub Cost",agg_sub),("Labour",agg_lab),("GM €",agg_gm)],10):
        bg=CT if ri%2==0 else W
        c=ws1.cell(ri,1,lbl); c.font=fnt(9,bold=True); c.fill=fill(bg); c.border=bdr()
        ytd=0
        for ci,m in enumerate(MONTHS,2):
            v=fn(m); c=ws1.cell(ri,ci,v if v else None)
            c.font=fnt(); c.fill=fill(bg); c.number_format=FMT_EUR; c.alignment=Alignment(horizontal="right"); c.border=bdr(); ytd+=v
        c=ws1.cell(ri,14,ytd if ytd else None); c.font=fnt(9,bold=True,color=G)
        c.fill=fill(bg); c.number_format=FMT_EUR; c.alignment=Alignment(horizontal="right"); c.border=bdr()
        ws1.row_dimensions[ri].height=16
    ws1.column_dimensions["A"].width=14
    for c in range(2,16): ws1.column_dimensions[get_column_letter(c)].width=10
    ws1.sheet_properties.tabColor=G

    # ── TAB 2: CONSOLIDATED P&L
    ws2=wb.create_sheet("Consolidated P&L")
    ws2.sheet_view.showGridLines=False
    title_row(ws2,f"CBRE Hellas  |  All Accounts  |  {year}  Consolidated Profit & Loss (EUR)",16)
    ws2.cell(2,1,"Line Item").font=hfnt(); ws2.cell(2,1).fill=fill(G); ws2.cell(2,1).alignment=Alignment(horizontal="left",indent=1); ws2.cell(2,1).border=bdr()
    ws2.cell(2,2,"Ref").font=hfnt(); ws2.cell(2,2).fill=fill(G); ws2.cell(2,2).alignment=Alignment(horizontal="center"); ws2.cell(2,2).border=bdr()
    for ci,m in enumerate(MONTHS,3):
        c=ws2.cell(2,ci,ML[m]); c.font=hfnt(); c.fill=fill(G); c.alignment=Alignment(horizontal="center"); c.border=bdr()
    ws2.cell(2,15,"YTD").font=hfnt(); ws2.cell(2,15).fill=fill(G); ws2.cell(2,15).alignment=Alignment(horizontal="center"); ws2.cell(2,15).border=bdr()
    ws2.cell(2,16,"# Clients").font=hfnt(); ws2.cell(2,16).fill=fill(G); ws2.cell(2,16).alignment=Alignment(horizontal="center"); ws2.cell(2,16).border=bdr()
    ws2.row_dimensions[1].height=36; ws2.row_dimensions[2].height=22

    def agg_rev_cat(m,cat): return sum(sum(i.get("amt",0) or 0 for i in c.get("inv",[]) if i.get("month")==m and cat in (i.get("cat","") or "")) for c in clients)
    def agg_sub_cat(m,cat): return sum(sum(i.get("amt",0) or 0 for i in c.get("sub",[]) if i.get("month")==m and cat in (i.get("cat","") or "")) for c in clients)
    
    rev_core={m:agg_rev_cat(m,"Core") for m in MONTHS}
    rev_ew={m:agg_rev_cat(m,"Extra") for m in MONTHS}
    rev_pjm={m:agg_rev_cat(m,"PJM") for m in MONTHS}
    rev_tot={m:rev_core[m]+rev_ew[m]+rev_pjm[m] for m in MONTHS}
    lab_tot={m:agg_lab(m) for m in MONTHS}
    sub_tot={m:agg_sub(m) for m in MONTHS}
    tot_c2={m:lab_tot[m]+sub_tot[m] for m in MONTHS}
    gm2={m:rev_tot[m]-tot_c2[m] for m in MONTHS}
    gm_pct2={m:(gm2[m]/rev_tot[m] if rev_tot[m] else None) for m in MONTHS}

    n_clients=len(clients)
    plines2=[
        ("REVENUE",None,"section",None,None),
        ("  CLIENT REVENUE - FM Core","rev_core","data",rev_core,None),
        ("  CLIENT REVENUE - FM Extra Works","rev_ew","data",rev_ew,None),
        ("  CLIENT REVENUE - PJMs","rev_pjm","data",rev_pjm,None),
        ("Total Sales / Revenue","","total",rev_tot,n_clients),
        (None,None,"spacer",None,None),
        ("LABOUR COST",None,"section",None,None),
        ("  Labour Cost (all categories)","lab","data",lab_tot,None),
        ("Total Labour Cost","","total",lab_tot,None),
        (None,None,"spacer",None,None),
        ("SUBCONTRACTOR COST",None,"section",None,None),
        ("  CLIENT Sub cost","sub","data",sub_tot,None),
        ("Total Subcontractor","","total",sub_tot,None),
        (None,None,"spacer",None,None),
        ("TOTAL COST","tc","grand_total",tot_c2,None),
        (None,None,"spacer",None,None),
        ("GM — GROSS MARGIN",None,"section",None,None),
        ("GM - Total €","gm","data",gm2,n_clients),
        ("GM - Total %","gm_pct","pct",gm_pct2,None),
    ]
    cur2=3
    for line in plines2:
        ws2.row_dimensions[cur2].height=5 if line[2]=="spacer" else 20 if line[2]=="section" else 18
        if line[2]=="spacer": cur2+=1; continue
        if line[2]=="section":
            ws2.merge_cells(start_row=cur2,start_column=1,end_row=cur2,end_column=2)
            c=ws2.cell(cur2,1,line[0]); c.font=fnt(9,bold=True,color=W)
            for cc in range(1,17): ws2.cell(cur2,cc).fill=fill(MB); ws2.cell(cur2,cc).border=bdr()
            cur2+=1; continue
        bg=WT if line[2] in("total","grand_total") else (CT if cur2%2==0 else W)
        is_tot=line[2] in("total","grand_total"); is_pct=line[2]=="pct"
        c=ws2.cell(cur2,1,line[0]); c.font=fnt(9,bold=is_tot); c.fill=fill(bg); c.alignment=Alignment(horizontal="left",indent=1 if is_tot else 2); c.border=bdr()
        ws2.cell(cur2,2,line[1] or "").font=fnt(9,italic=True,color="999999"); ws2.cell(cur2,2).fill=fill(bg); ws2.cell(cur2,2).border=bdr()
        ytd2=0
        for ci,m in enumerate(MONTHS,3):
            v=line[3].get(m,0); c=ws2.cell(cur2,ci,v if v else None)
            c.number_format=FMT_PCT if is_pct else FMT_EUR; c.fill=fill(bg); c.border=bdr()
            c.alignment=Alignment(horizontal="right"); c.font=fnt(9,bold=is_tot,italic=is_pct); ytd2+=v or 0
        ytdc=ws2.cell(cur2,15,ytd2 if ytd2 else None); ytdc.number_format=FMT_PCT if is_pct else FMT_EUR
        ytdc.fill=fill(bg); ytdc.border=bdr(); ytdc.alignment=Alignment(horizontal="right"); ytdc.font=fnt(9,bold=True,color=G if not is_tot else DG)
        if line[4]: ws2.cell(cur2,16,line[4]).font=fnt(9,italic=True,color=DG); ws2.cell(cur2,16).fill=fill(bg); ws2.cell(cur2,16).alignment=Alignment(horizontal="center")
        ws2.cell(cur2,16).border=bdr(); cur2+=1
    ws2.column_dimensions["A"].width=32; ws2.column_dimensions["B"].width=8
    for i in range(3,17): ws2.column_dimensions[get_column_letter(i)].width=11
    ws2.freeze_panes="C3"; ws2.sheet_properties.tabColor=G

    # ── TAB 3: CLIENT BREAKDOWN (Revenue Matrix)
    ws3=wb.create_sheet("Client Breakdown")
    title_row(ws3,f"CBRE Hellas  |  {year}  Client Revenue & GM Breakdown",len(clients)+4)
    hdrs3=["Client","Status"]+[ML[m] for m in MONTHS]+["YTD Rev","YTD Cost","YTD GM","GM %"]
    for ci,h in enumerate(hdrs3,1):
        c=ws3.cell(2,ci,h); c.font=hfnt(8 if ci>2 else 9); c.fill=fill(G)
        c.alignment=Alignment(horizontal="center" if ci>1 else "left",vertical="center",wrap_text=True); c.border=bdr()
    ws3.row_dimensions[2].height=26
    stat_col={"draft":"ECEFF1","submitted":"C8E6C9","approved":"A5D6A7","rejected":"FFCDD2"}
    for ri,cl in enumerate(sorted(clients,key=lambda x:x.get("client","")),3):
        bg=CT if ri%2==0 else W; ws3.row_dimensions[ri].height=16
        cname=cl.get("client",""); st=cl.get("status","draft")
        c=ws3.cell(ri,1,cname); c.font=fnt(9,bold=True,color=G); c.fill=fill(bg); c.border=bdr()
        st_lbl={"draft":"⬜ Draft","submitted":"✅ Sub","approved":"✅ Appr","rejected":"❌ Rej"}.get(st,"⬜")
        c=ws3.cell(ri,2,st_lbl); c.font=fnt(8); c.fill=fill(stat_col.get(st,bg)); c.alignment=Alignment(horizontal="center"); c.border=bdr()
        ytd_r=ytd_c3=0
        for ci2,m in enumerate(MONTHS,3):
            rev=sum(i.get("amt",0) or 0 for i in cl.get("inv",[]) if i.get("month")==m)
            c=ws3.cell(ri,ci2,rev if rev else None); c.font=fnt(); c.fill=fill(bg)
            c.number_format=FMT_EUR; c.alignment=Alignment(horizontal="right"); c.border=bdr(); ytd_r+=rev
        cost=sum(sum(i.get("amt",0) or 0 for i in cl.get("sub",[]))+sum(v for v in (cl.get("lab",{}).get(m) or {}).values() if isinstance(v,(int,float))) for m in MONTHS)
        gm3=ytd_r-cost; gm_p3=gm3/ytd_r if ytd_r else None
        for ci2,v,fmt in [(15,ytd_r,FMT_EUR),(16,cost,FMT_EUR),(17,gm3,FMT_EUR),(18,gm_p3,FMT_PCT)]:
            c=ws3.cell(ri,ci2,v if v else None); c.font=fnt(9,bold=True,color=G if ci2==17 else DG)
            c.fill=fill(bg); c.number_format=fmt; c.alignment=Alignment(horizontal="right"); c.border=bdr()
    # Totals
    tr3=len(clients)+3; ws3.row_dimensions[tr3].height=20
    for cc in range(1,19): ws3.cell(tr3,cc).fill=fill(G); ws3.cell(tr3,cc).border=bdr()
    ws3.cell(tr3,1,"TOTAL ALL CLIENTS").font=hfnt()
    for ci2 in range(3,19):
        col=get_column_letter(ci2)
        ws3.cell(tr3,ci2,f"=SUM({col}3:{col}{tr3-1})").font=hfnt()
        ws3.cell(tr3,ci2).number_format=FMT_EUR; ws3.cell(tr3,ci2).fill=fill(G)
        ws3.cell(tr3,ci2).alignment=Alignment(horizontal="right"); ws3.cell(tr3,ci2).border=bdr()
    ws3.column_dimensions["A"].width=28; ws3.column_dimensions["B"].width=8
    for i in range(3,19): ws3.column_dimensions[get_column_letter(i)].width=10
    ws3.freeze_panes="C3"; ws3.sheet_properties.tabColor=DG

    # ── TAB 4: MEC STATUS
    ws4=wb.create_sheet("MEC Status")
    title_row(ws4,f"CBRE Hellas  |  {year}  Month-End Close Status — All Clients",len(MONTHS)+3)
    ws4.cell(2,1,"Client").font=hfnt(); ws4.cell(2,1).fill=fill(G); ws4.cell(2,1).border=bdr()
    ws4.cell(2,2,"Status").font=hfnt(); ws4.cell(2,2).fill=fill(G); ws4.cell(2,2).border=bdr()
    ws4.cell(2,3,"Submitted By").font=hfnt(); ws4.cell(2,3).fill=fill(G); ws4.cell(2,3).border=bdr()
    for ci,m in enumerate(MONTHS,4):
        c=ws4.cell(2,ci,ML[m]); c.font=hfnt(8); c.fill=fill(G); c.alignment=Alignment(horizontal="center"); c.border=bdr()
    ws4.row_dimensions[2].height=24
    for ri,cl in enumerate(sorted(clients,key=lambda x:x.get("client","")),3):
        bg=CT if ri%2==0 else W; ws4.row_dimensions[ri].height=16
        cname=cl.get("client",""); st=cl.get("status","draft")
        ws4.cell(ri,1,cname).font=fnt(9,bold=True,color=G); ws4.cell(ri,1).fill=fill(bg); ws4.cell(ri,1).border=bdr()
        st_lbl={"draft":"⬜ Draft","submitted":"✅ Submitted","approved":"✅ Approved","rejected":"❌ Rejected"}.get(st,"⬜ Draft")
        sc3={"⬜ Draft":"ECEFF1","✅ Submitted":"C8E6C9","✅ Approved":"A5D6A7","❌ Rejected":"FFCDD2"}.get(st_lbl,bg)
        ws4.cell(ri,2,st_lbl).font=fnt(9,bold=True); ws4.cell(ri,2).fill=fill(sc3); ws4.cell(ri,2).alignment=Alignment(horizontal="center"); ws4.cell(ri,2).border=bdr()
        ws4.cell(ri,3,cl.get("submittedBy","")).font=fnt(); ws4.cell(ri,3).fill=fill(bg); ws4.cell(ri,3).border=bdr()
        for ci,m in enumerate(MONTHS,4):
            has_data=any(i.get("month")==m for i in cl.get("inv",[])+cl.get("sub",[]))
            v="✅" if has_data else "·"
            c=ws4.cell(ri,ci,v); c.font=fnt(9,color=G if has_data else "CCCCCC")
            c.fill=fill(bg); c.alignment=Alignment(horizontal="center"); c.border=bdr()
    ws4.column_dimensions["A"].width=28; ws4.column_dimensions["B"].width=14; ws4.column_dimensions["C"].width=16
    for i in range(4,4+len(MONTHS)): ws4.column_dimensions[get_column_letter(i)].width=8
    ws4.sheet_properties.tabColor="17E88F"

    buf=io.BytesIO(); wb.save(buf); return buf.getvalue()

if __name__=="__main__":
    import sys
    args=sys.argv[1:]
    data=json.load(sys.stdin)
    if "--consolidated" in args:
        result=run_consolidated(data)
    else:
        result=run(data)
    sys.stdout.buffer.write(result)
