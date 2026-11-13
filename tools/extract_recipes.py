import sys, json, glob, os
import xml.etree.ElementTree as ET
DC, OUT = sys.argv[1], sys.argv[2]
def ti(v,d=0):
    try: return int(float(v))
    except: return d
rec={}
for p in glob.glob(os.path.join(DC,"ItemProduceRecipe","*.xml")):
    try: root=ET.parse(p).getroot()
    except ET.ParseError: continue
    for r in root.iter("Recipe"):
        rid=ti(r.get("id"))
        if not rid: continue
        res=r.find("Result")
        mats=[[ti(m.get("id")),ti(m.get("count"),1)] for m in r.iter("Material") if ti(m.get("id"))]
        rec[str(rid)]={
            "r":[ti(res.get("id")),ti(res.get("count"),1)] if res is not None else [0,0],
            "c":[ti(res.get("criticalItemId")),ti(res.get("criticalItemCount"))] if res is not None else [0,0],
            "m":mats,
            "sk":ti(r.get("needSkillId")),
            "pf":ti(r.get("needSkillProf"))
        }
json.dump(rec, open(os.path.join(OUT,"recipes.json"),"w",encoding="utf-8"), ensure_ascii=False, separators=(",",":"))
print("recipes:",len(rec))
