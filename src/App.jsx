import { useState, useEffect, useCallback } from "react";

const T = {
  bg: "#0a0e17", surface: "#111827", surfaceLight: "#1e293b", border: "#2d3a4f",
  accent: "#00e5a0", accentDim: "#00e5a033", warning: "#f59e0b", danger: "#ef4444",
  info: "#38bdf8", purple: "#a78bfa", text: "#e2e8f0", textDim: "#94a3b8", textMuted: "#64748b",
};
const F = `'JetBrains Mono','Fira Code',monospace`;
const FS = `'DM Sans','Segoe UI',system-ui,sans-serif`;

const SZ = { char:1,"signed char":1,"unsigned char":1, short:2,"short int":2,"unsigned short":2,"unsigned short int":2, int:4,"unsigned int":4,"signed int":4, long:8,"long int":8,"unsigned long":8,"unsigned long int":8, "long long":8,"long long int":8,"unsigned long long":8, float:4, double:8,"long double":16 };
const AL = { ...SZ };
const TD = { char:"char","signed char":"char","unsigned char":"char", short:"int","short int":"int","unsigned short":"int", int:"int","unsigned int":"int","signed int":"int", long:"int","long int":"int","unsigned long":"int", "long long":"int","long long int":"int","unsigned long long":"int", float:"float", double:"double","long double":"double" };

function parseStructs(code) {
  const structs = {};
  const re = /(?:typedef\s+)?struct\s+(\w+)\s*\{([^}]*)\}\s*(\w*)\s*;/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const fields = [];
    const fre = /\s*([\w\s*]+?)\s+(\*?\w+)(?:\[(\d+)\])?\s*;/g;
    let fm;
    while ((fm = fre.exec(m[2])) !== null) {
      let ft = fm[1].trim(), fn = fm[2].trim(), ip = false;
      if (fn.startsWith("*")) { ip = true; fn = fn.slice(1); }
      if (ft.endsWith("*")) { ip = true; ft = ft.slice(0,-1).trim(); }
      fields.push({ type: ft, name: fn, isPointer: ip, arraySize: fm[3] ? parseInt(fm[3]) : null });
    }
    structs[m[1]] = { name: m[1], alias: m[3]||null, fields };
    if (m[3]) structs[m[3]] = structs[m[1]];
  }
  return structs;
}

function parseEnums(code) {
  const enums = {};
  const re = /enum\s+(\w+)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    enums[m[1]] = m[2].split(",").map((v,i) => { const p = v.trim().split("="); return { name: p[0].trim(), value: p[1] ? parseInt(p[1].trim()) : i }; }).filter(v => v.name);
  }
  return enums;
}

function parseDefines(code) {
  const d = {};
  const re = /#define\s+(\w+)\s+(.+)/g;
  let m;
  while ((m = re.exec(code)) !== null) d[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1");
  return d;
}

function rv(val, defines, enums) {
  if (!val) return val;
  let v = val.trim();
  if (defines[v]) return defines[v];
  for (const en of Object.keys(enums)) { const ev = enums[en].find(e => e.name === v); if (ev) return String(ev.value); }
  if (/^0\d+$/.test(v)) return String(parseInt(v, 8));
  if (/^0x[\da-fA-F]+$/i.test(v)) return String(parseInt(v, 16));
  return v;
}

function align(addr, a) { const r = addr % a; return r === 0 ? addr : addr + (a - r); }
function fmtAddr(b, o) { return "0x" + (b + o).toString(16).padStart(6, "0"); }

function parseCode(code) {
  const structs = parseStructs(code), enums = parseEnums(code), defines = parseDefines(code);
  const cells = [], pointers = [], varMap = {};
  let offset = 0;
  const BASE = 0x7ffc00;
  const mainMatch = code.match(/\bmain\s*\([^)]*\)\s*\{([\s\S]*)\}/);
  const body = mainMatch ? mainMatch[1] : code.replace(/#\s*(include|define|ifndef|endif|ifdef)\b.*$/gm,"").replace(/\/\*[\s\S]*?\*\//g,"").replace(/\/\/.*$/gm,"").replace(/(?:typedef\s+)?struct\s+\w+\s*\{[^}]*\}\s*\w*\s*;/g,"").replace(/enum\s+\w+\s*\{[^}]*\}\s*;?/g,"");
  const lines = body.split("\n").map(l=>l.trim()).filter(l=>l&&!l.startsWith("//")&&!l.startsWith("/*")&&!l.startsWith("*")&&!l.startsWith("printf")&&!l.startsWith("return")&&!l.startsWith("{")&&!l.startsWith("}"));

  for (const line of lines) {
    if (/^\w+\.\w+\s*=/.test(line)) {
      const am = line.match(/^(\w+)\.(\w+)\s*=\s*(.+?)\s*;/);
      if (am) { for (const c of cells) { if (c._sv === am[1] && c.label === `.${am[2]}`) c.value = rv(am[3], defines, enums); } }
      continue;
    }
    if (/^\*?\w+\s*=/.test(line) && !/(int|char|float|double|long|short|unsigned|signed|struct|enum|void)\s/.test(line)) continue;

    // Array
    const arrM = line.match(/^([\w\s]+?)\s+(\w+)\s*\[\s*(\d+)?\s*\]\s*(?:=\s*\{([^}]*)\})?\s*;?$/);
    if (arrM) {
      let [,rt,nm,sz,il] = arrM; rt=rt.trim();
      const tk = Object.keys(SZ).find(k=>rt.includes(k))||rt;
      const es=SZ[tk]||4, al=AL[tk]||4;
      const vals = il ? il.split(",").map(v=>rv(v.trim(),defines,enums)) : [];
      const cnt = sz ? parseInt(sz) : vals.length;
      offset = align(offset, al);
      for (let i=0;i<cnt;i++) {
        const dt = TD[tk]||"array";
        cells.push({ address:fmtAddr(BASE,offset), value:vals[i]||"0", label:`${nm}[${i}]`, type:dt==="int"||dt==="float"||dt==="double"||dt==="char"?dt:"array", annotation:`${es} byte${es>1?"s":""}`, _name:`${nm}[${i}]`, _vb:nm });
        if(i===0)varMap[nm]=cells.length-1;
        varMap[`${nm}[${i}]`]=cells.length-1;
        offset+=es;
      }
      continue;
    }

    // Pointer
    const ptrM = line.match(/^([\w\s]+?)\s+(\*{1,3})(\w+)\s*(?:=\s*(.+?))?\s*;?$/);
    if (ptrM) {
      let [,rt,stars,nm,iv] = ptrM; rt=rt.trim();
      offset = align(offset, 8);
      let tgt = null;
      if (iv) {
        const ao = iv.trim().match(/^&(\w+)/); if(ao) tgt=ao[1];
        const ca = iv.trim().match(/^\([^)]+\)\s*&(\w+)/); if(ca) tgt=ca[1];
        if (!tgt && varMap[iv.trim()]!==undefined) tgt=iv.trim();
      }
      const ci = cells.length;
      cells.push({
        address:fmtAddr(BASE,offset), value:tgt&&varMap[tgt]!==undefined?cells[varMap[tgt]].address:(iv?iv.trim():"NULL"),
        label:nm, type:"pointer", annotation:`8 bytes (${stars}${rt.replace("enum ","").replace("struct ","")})`,
        _name:nm, _tgt:tgt,
      });
      varMap[nm]=ci;
      if(tgt&&varMap[tgt]!==undefined) pointers.push({from:ci,to:varMap[tgt],color:stars.length>1?T.purple:T.accent});
      offset+=8;
      continue;
    }

    // Struct var
    const stM = line.match(/^(?:struct\s+)?(\w+)\s+(\w+)\s*(?:=\s*\{([^}]*)\})?\s*;?$/);
    if (stM && structs[stM[1]]) {
      const [,tn,vn,il] = stM;
      const st = structs[tn];
      const vals = il ? il.split(",").map(v=>rv(v.trim(),defines,enums)) : [];
      let ma=1; for(const f of st.fields){const a=f.isPointer?8:(AL[f.type]||4);if(a>ma)ma=a;}
      offset=align(offset,ma);
      varMap[vn]=cells.length;
      st.fields.forEach((f,fi)=>{
        const fs=f.isPointer?8:(SZ[f.type]||4), fa=f.isPointer?8:(AL[f.type]||4);
        const al2=align(offset,fa);
        if(al2>offset){cells.push({address:fmtAddr(BASE,offset),value:"—".repeat(Math.min(al2-offset,7)),label:"",type:"padding",annotation:`${al2-offset}B padding`,_sv:vn});offset=al2;}
        cells.push({address:fmtAddr(BASE,offset),value:vals[fi]||"?",label:`.${f.name}`,type:f.isPointer?"pointer":(TD[f.type]||"struct"),annotation:`${fs} byte${fs>1?"s":""}`,_name:`${vn}.${f.name}`,_sv:vn});
        varMap[`${vn}.${f.name}`]=cells.length-1;
        offset+=fs;
      });
      const ta=align(offset,ma);
      if(ta>offset){cells.push({address:fmtAddr(BASE,offset),value:"—".repeat(Math.min(ta-offset,7)),label:"",type:"padding",annotation:`${ta-offset}B trailing pad`,_sv:vn});offset=ta;}
      continue;
    }

    // Enum var
    const enM = line.match(/^enum\s+(\w+)\s+(\w+)\s*(?:=\s*(\w+))?\s*;?$/);
    if (enM) {
      const [,en,vn,iv] = enM;
      offset=align(offset,4);
      const r=iv?rv(iv,defines,enums):"0";
      const ed=enums[en], el=ed?ed.map(e=>`${e.value}=${e.name}`).join(", "):"";
      cells.push({address:fmtAddr(BASE,offset),value:r,label:vn,type:"int",annotation:`4B (enum ${en}: ${el})`,_name:vn});
      varMap[vn]=cells.length-1; offset+=4;
      continue;
    }

    // Basic var
    const bM = line.match(/^([\w\s]+?)\s+(\w+)\s*(?:=\s*(.+?))?\s*;?$/);
    if (bM) {
      let [,rt,nm,iv] = bM; rt=rt.trim();
      if(/^(return|if|else|for|while|switch|case|break|continue|printf|scanf)$/.test(rt))continue;
      if(/^(return|if|else|for|while|switch|case|break|continue|printf|scanf)$/.test(nm))continue;
      const tk=Object.keys(SZ).find(k=>{const w=k.split(" ");return w.every(x=>rt.split(/\s+/).includes(x));})||rt;
      const s=SZ[tk]; if(!s)continue;
      offset=align(offset,AL[tk]||s);
      cells.push({address:fmtAddr(BASE,offset),value:iv?rv(iv.replace(/[LlFf]$/,""),defines,enums):"?",label:nm,type:TD[tk]||"int",annotation:`${s} byte${s>1?"s":""} (${rt})`,_name:nm});
      varMap[nm]=cells.length-1; offset+=s;
    }
  }

  for(const c of cells){if(c._tgt&&varMap[c._tgt]!==undefined)c.value=cells[varMap[c._tgt]].address;}
  return { cells, pointers };
}

// ═══ PRESETS ═══
const scenarios = [
  { id:"basic-types",title:"Basic Data Types",description:"See how int, char, float, and double are stored in memory with their sizes and addresses.",
    code:`int x = 42;\nchar ch = 'A';\nfloat f = 3.14;\ndouble d = 2.718;`,
    cells:[{address:"0x7ffc00",value:"42",label:"x",type:"int",annotation:"4 bytes (0x0000002A)"},{address:"0x7ffc04",value:"'A' (65)",label:"ch",type:"char",annotation:"1 byte (0x41)"},{address:"0x7ffc05",value:"—",label:"",type:"padding",annotation:"3 bytes padding (alignment)"},{address:"0x7ffc08",value:"3.14",label:"f",type:"float",annotation:"4 bytes (IEEE 754)"},{address:"0x7ffc0c",value:"2.718",label:"d",type:"double",annotation:"8 bytes (IEEE 754)"}],
    notes:["Variables are stored at aligned addresses for CPU efficiency","char takes 1 byte, but padding is added for alignment","float uses 4 bytes (single precision IEEE 754)","double uses 8 bytes (double precision IEEE 754)"]},
  { id:"pointer-basics",title:"Pointer Basics",description:"A pointer stores the address of another variable. Dereferencing (*p) retrieves the value.",
    code:`int var = 5;\nint *p = &var;\n// *p == 5\n// p == 0x7ffc00`,
    cells:[{address:"0x7ffc00",value:"5",label:"var",type:"int",annotation:"4 bytes"},{address:"0x7ffc08",value:"0x7ffc00",label:"p",type:"pointer",annotation:"8 bytes (points to var)"}],
    pointers:[{from:1,to:0,color:T.accent}],
    notes:["p stores the address of var (0x7ffc00)","*p dereferences: follows the address to get 5","&var gives the address of var","Pointer size is 8 bytes on 64-bit systems"]},
  { id:"pointer-to-pointer",title:"Pointer to Pointer",description:"A pointer can point to another pointer, creating levels of indirection.",
    code:`char c = 'A';\nchar *pc = &c;\nchar **ppc = &pc;`,
    cells:[{address:"0x7ffc00",value:"'A' (65)",label:"c",type:"char",annotation:"1 byte"},{address:"0x7ffc08",value:"0x7ffc00",label:"pc",type:"pointer",annotation:"8 bytes → c"},{address:"0x7ffc10",value:"0x7ffc08",label:"ppc",type:"pointer",annotation:"8 bytes → pc"}],
    pointers:[{from:1,to:0,color:T.accent},{from:2,to:1,color:T.purple}],
    notes:["*ppc gives pc (0x7ffc00)","**ppc gives c ('A')","Each level of indirection adds a pointer (8 bytes)","Types must match: char** can't point to int*"]},
  { id:"array-memory",title:"Arrays & Pointer Arithmetic",description:"Array elements are stored contiguously. A pointer can traverse them with arithmetic.",
    code:`int nums[] = {10, 20, 30};\nint *p = nums;\n// *(p+1) == 20`,
    cells:[{address:"0x7ffc00",value:"10",label:"nums[0]",type:"array",annotation:"4 bytes"},{address:"0x7ffc04",value:"20",label:"nums[1]",type:"array",annotation:"4 bytes"},{address:"0x7ffc08",value:"30",label:"nums[2]",type:"array",annotation:"4 bytes"},{address:"0x7ffc10",value:"0x7ffc00",label:"p",type:"pointer",annotation:"points to nums[0]"}],
    pointers:[{from:3,to:0,color:T.accent}],
    notes:["Array name decays to pointer to first element","p+1 advances by sizeof(int) = 4 bytes","*(p+i) is equivalent to nums[i]","Elements are contiguous in memory"]},
  { id:"char-array",title:"Char Array vs Double Array",description:"Pointer arithmetic depends on the type. char* advances 1 byte, double* advances 8 bytes.",
    code:`char letters[] = {'a','b','c'};\ndouble vals[] = {1.0, 2.0, 3.0};`,
    cells:[{address:"0x7ffc00",value:"'a'",label:"letters[0]",type:"char",annotation:"1 byte"},{address:"0x7ffc01",value:"'b'",label:"letters[1]",type:"char",annotation:"1 byte"},{address:"0x7ffc02",value:"'c'",label:"letters[2]",type:"char",annotation:"1 byte"},{address:"0x7ffc08",value:"1.0",label:"vals[0]",type:"double",annotation:"8 bytes"},{address:"0x7ffc10",value:"2.0",label:"vals[1]",type:"double",annotation:"8 bytes"},{address:"0x7ffc18",value:"3.0",label:"vals[2]",type:"double",annotation:"8 bytes"}],
    notes:["char elements are 1 byte apart","double elements are 8 bytes apart","Pointer arithmetic scales by element size","p+1 on char* moves 1 byte; on double* moves 8 bytes"]},
  { id:"struct-layout",title:"Struct Memory Layout",description:"Structs group data together. The compiler may add padding for alignment.",
    code:`struct Example {\n  char c;\n  int x;\n  char d;\n  double y;\n};\n// sizeof = 24 (with padding!)`,
    cells:[{address:"0x7ffc00",value:"'A'",label:".c",type:"char",annotation:"1 byte"},{address:"0x7ffc01",value:"— — —",label:"",type:"padding",annotation:"3 bytes padding"},{address:"0x7ffc04",value:"42",label:".x",type:"int",annotation:"4 bytes"},{address:"0x7ffc08",value:"'B'",label:".d",type:"char",annotation:"1 byte"},{address:"0x7ffc09",value:"— — — — — — —",label:"",type:"padding",annotation:"7 bytes padding"},{address:"0x7ffc10",value:"3.14",label:".y",type:"double",annotation:"8 bytes"}],
    notes:["Total size: 24 bytes (not 14!)","Padding after .c aligns .x to 4-byte boundary","Padding after .d aligns .y to 8-byte boundary","Reordering fields can reduce struct size!"]},
  { id:"struct-optimized",title:"Struct Optimization",description:"Reordering fields minimizes padding. Compare this to the previous layout.",
    code:`struct Optimized {\n  double y;\n  int x;\n  char c;\n  char d;\n};\n// sizeof = 16 (saved 8 bytes!)`,
    cells:[{address:"0x7ffc00",value:"3.14",label:".y",type:"double",annotation:"8 bytes"},{address:"0x7ffc08",value:"42",label:".x",type:"int",annotation:"4 bytes"},{address:"0x7ffc0c",value:"'A'",label:".c",type:"char",annotation:"1 byte"},{address:"0x7ffc0d",value:"'B'",label:".d",type:"char",annotation:"1 byte"},{address:"0x7ffc0e",value:"— —",label:"",type:"padding",annotation:"2 bytes trailing padding"}],
    notes:["Total size: 16 bytes (down from 24!)","Largest members first reduces internal padding","Trailing padding aligns struct for arrays","Rule of thumb: sort fields by size, largest first"]},
  { id:"void-pointer",title:"Void Pointers",description:"A void* is a generic pointer — it can hold any address but must be cast before dereferencing.",
    code:`void *ptr;\nint x = 10;\nchar ch = 'A';\nptr = &ch;`,
    cells:[{address:"0x7ffc00",value:"10",label:"x",type:"int",annotation:"4 bytes"},{address:"0x7ffc04",value:"'A' (65)",label:"ch",type:"char",annotation:"1 byte"},{address:"0x7ffc08",value:"0x7ffc04",label:"ptr",type:"pointer",annotation:"8 bytes (void*) → ch"}],
    pointers:[{from:2,to:1,color:"#f59e0b"}],
    notes:["void* has no type info — can point to anything","Cannot dereference without casting","malloc() returns void*","Used for generic/polymorphic functions"]},
  { id:"function-pointer",title:"Function Pointers",description:"Functions live in memory too. A function pointer stores the address of a function's code.",
    code:`void greet() {\n  printf("Hello!\\n");\n}\nvoid (*fptr)() = &greet;\nfptr(); // calls greet()`,
    cells:[{address:"0x401000",value:"greet() code",label:"greet",type:"pointer",annotation:"TEXT segment"},{address:"0x7ffc00",value:"0x401000",label:"fptr",type:"pointer",annotation:"8 bytes → greet()"}],
    pointers:[{from:1,to:0,color:T.accent}],
    notes:["Function code lives in the TEXT segment","Function pointer stores entry address","& is optional: greet == &greet","Used for callbacks (qsort, signal handlers)"]},
];

const EXAMPLES = [
  { label:"Pointers & arrays", code:`#include <stdio.h>\n\nint main() {\n    int x = 42;\n    int y = 99;\n    int *px = &x;\n    int *py = &y;\n    double arr[] = {1.5, 2.5, 3.5};\n    return 0;\n}` },
  { label:"Struct with padding", code:`#include <stdio.h>\n\nstruct Student {\n    char grade;\n    int id;\n    char initial;\n    double gpa;\n};\n\nint main() {\n    struct Student s1 = {'A', 1001, 'J', 3.95};\n    return 0;\n}` },
  { label:"Pointer chain", code:`#include <stdio.h>\n\nint main() {\n    int val = 7;\n    int *p1 = &val;\n    int **p2 = &p1;\n    char c = 'Z';\n    char *pc = &c;\n    return 0;\n}` },
  { label:"Mixed types", code:`#include <stdio.h>\n\n#define MAX 100\n\nenum Status { OFF, ON, STANDBY };\n\nint main() {\n    int count = MAX;\n    float ratio = 0.75;\n    char tag = 'X';\n    double pi = 3.14159;\n    enum Status state = ON;\n    long big = 9999999;\n    return 0;\n}` },
  { label:"Optimized struct", code:`#include <stdio.h>\n\nstruct Bad {\n    char a;\n    double b;\n    char c;\n    int d;\n};\n\nstruct Good {\n    double b;\n    int d;\n    char a;\n    char c;\n};\n\nint main() {\n    struct Bad bad = {'X', 3.14, 'Y', 42};\n    struct Good good = {3.14, 42, 'X', 'Y'};\n    return 0;\n}` },
];

// ═══ UI ═══
function MemoryCell({address,value,label,type,highlighted,onClick,annotation}) {
  const tc = {int:"#38bdf8",char:"#a78bfa",float:"#f59e0b",double:"#fb923c",pointer:"#00e5a0",struct:"#f472b6",padding:"#475569",empty:"#1e293b",array:"#818cf8"};
  const c = tc[type]||T.textDim;
  return (
    <div onClick={onClick} style={{display:"flex",alignItems:"center",cursor:onClick?"pointer":"default",transition:"all 0.2s",transform:highlighted?"scale(1.02)":"scale(1)",filter:highlighted?`drop-shadow(0 0 12px ${c}44)`:"none"}}>
      <div style={{fontFamily:F,fontSize:10,color:T.textMuted,width:80,textAlign:"right",paddingRight:8,flexShrink:0}}>{address}</div>
      <div style={{display:"flex",flexDirection:"column",minHeight:32,justifyContent:"center",border:`1.5px solid ${highlighted?c:c+"55"}`,borderRadius:4,padding:"4px 12px",background:highlighted?c+"18":T.surface,flex:1,minWidth:100,transition:"all 0.25s"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontFamily:F,fontSize:12.5,color:c,fontWeight:600}}>{value}</span>
          {label&&<span style={{fontFamily:F,fontSize:10,color:T.textDim}}>{label}</span>}
        </div>
        {annotation&&<span style={{fontFamily:F,fontSize:9,color:T.textMuted,marginTop:2}}>{annotation}</span>}
      </div>
      <div style={{fontFamily:F,fontSize:9,color:c+"aa",width:50,paddingLeft:8,flexShrink:0}}>{type}</div>
    </div>
  );
}

function PtrArrow({fromY,toY,color=T.accent}) {
  const h=Math.abs(toY-fromY), dir=toY>fromY?1:-1;
  if(h<2)return null;
  return (
    <svg style={{position:"absolute",left:-36,top:Math.min(fromY,toY),width:36,height:h+10,overflow:"visible"}}>
      <path d={`M 34 ${dir>0?0:h} C 8 ${dir>0?0:h}, 8 ${dir>0?h:0}, 34 ${dir>0?h:0}`} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray="4 3"/>
      <polygon points={`30,${dir>0?h-4:4} 34,${dir>0?h+4:-4} 38,${dir>0?h-4:4}`} fill={color}/>
    </svg>
  );
}

function CodeBlock({code}) {
  const kw=["int","char","float","double","void","struct","enum","typedef","return","for","if","else","sizeof","printf","extern","short","long","unsigned","signed","const","static"];
  const hl=(line)=>{
    if(line.trim().startsWith("//")||line.trim().startsWith("#"))return <span style={{color:"#6b7280",fontStyle:"italic"}}>{line}</span>;
    return line.split(/(\"[^\"]*\"|\'[^\']*\')/g).map((p,i)=>{
      if(p.startsWith('"')||p.startsWith("'"))return <span key={i} style={{color:"#fbbf24"}}>{p}</span>;
      return p.split(new RegExp(`\\b(${kw.join("|")})\\b`,"g")).map((w,j)=>{
        if(kw.includes(w))return <span key={`${i}-${j}`} style={{color:"#38bdf8",fontWeight:600}}>{w}</span>;
        return w.split(/(\b\d+\.?\d*\b|0x[0-9a-fA-F]+)/g).map((n,k)=>{
          if(/^(\d+\.?\d*|0x[0-9a-fA-F]+)$/.test(n))return <span key={`${i}-${j}-${k}`} style={{color:"#a78bfa"}}>{n}</span>;
          return <span key={`${i}-${j}-${k}`}>{n}</span>;
        });
      });
    });
  };
  return (
    <div style={{background:"#0d1117",borderRadius:8,border:`1px solid ${T.border}`,padding:"14px 18px",fontFamily:F,fontSize:12,lineHeight:1.7,color:T.text,overflowX:"auto"}}>
      {code.split("\n").map((l,i)=>(<div key={i} style={{display:"flex"}}><span style={{color:T.textMuted,width:28,flexShrink:0,textAlign:"right",paddingRight:12,userSelect:"none"}}>{i+1}</span><span>{hl(l)}</span></div>))}
    </div>
  );
}

function LayoutPanel({cells,pointers,hc,setHc}) {
  const ch=44;
  return (
    <div>
      <div style={{fontFamily:F,fontSize:10,color:T.textMuted,letterSpacing:2,textTransform:"uppercase",marginBottom:10,display:"flex",justifyContent:"space-between"}}>
        <span>Memory Layout</span><span style={{letterSpacing:0,textTransform:"none",fontSize:9}}>click cells to highlight</span>
      </div>
      {cells.length===0?(
        <div style={{background:T.surface,borderRadius:8,border:`1px dashed ${T.border}`,padding:"48px 24px",textAlign:"center"}}>
          <div style={{fontFamily:F,fontSize:32,marginBottom:8,opacity:0.3}}>⌗</div>
          <div style={{fontFamily:FS,fontSize:13,color:T.textMuted}}>Write some C code to see the memory layout</div>
          <div style={{fontFamily:FS,fontSize:11,color:T.textMuted,marginTop:4,opacity:0.6}}>Declare variables, arrays, structs, or pointers</div>
        </div>
      ):(
        <div style={{background:T.surface,borderRadius:8,border:`1px solid ${T.border}`,padding:"20px 20px 20px 56px",position:"relative"}}>
          <div style={{display:"flex",marginBottom:12,paddingBottom:8,borderBottom:`1px solid ${T.border}`}}>
            <span style={{width:80,textAlign:"right",paddingRight:8,fontFamily:F,fontSize:9,color:T.textMuted}}>ADDRESS</span>
            <span style={{flex:1,fontFamily:F,fontSize:9,color:T.textMuted}}>VALUE</span>
            <span style={{width:50,paddingLeft:8,fontFamily:F,fontSize:9,color:T.textMuted}}>TYPE</span>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:4,position:"relative"}}>
            {cells.map((c,i)=>(<MemoryCell key={i} {...c} highlighted={hc===i} onClick={()=>setHc(hc===i?null:i)}/>))}
            {pointers?.map((p,i)=>{const fy=p.from*ch+ch/2+2,ty=p.to*ch+ch/2+2;return <PtrArrow key={i} fromY={fy} toY={ty} color={p.color||T.accent}/>;})}
          </div>
          <div style={{position:"absolute",right:8,top:42,bottom:20,width:16,display:"flex",flexDirection:"column",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontFamily:F,fontSize:8,color:T.textMuted,writingMode:"vertical-lr"}}>LOW</span>
            <div style={{flex:1,width:1,background:`linear-gradient(to bottom, ${T.accent}44, ${T.danger}44)`,margin:"4px 0"}}/>
            <span style={{fontFamily:F,fontSize:8,color:T.textMuted,writingMode:"vertical-lr"}}>HIGH</span>
          </div>
        </div>
      )}
      <div style={{display:"flex",flexWrap:"wrap",gap:12,marginTop:12,padding:"8px 12px",background:T.surface,borderRadius:6,border:`1px solid ${T.border}`}}>
        {[{t:"int",c:"#38bdf8"},{t:"char",c:"#a78bfa"},{t:"float",c:"#f59e0b"},{t:"double",c:"#fb923c"},{t:"pointer",c:"#00e5a0"},{t:"struct",c:"#f472b6"},{t:"padding",c:"#475569"},{t:"array",c:"#818cf8"}].map(({t:tp,c:cl})=>(
          <div key={tp} style={{display:"flex",alignItems:"center",gap:5}}>
            <div style={{width:8,height:8,borderRadius:2,background:cl}}/><span style={{fontFamily:F,fontSize:10,color:T.textDim}}>{tp}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SideNav({active,onSelect,mode,onMode}) {
  return (
    <div style={{width:230,borderRight:`1px solid ${T.border}`,padding:"16px 0",display:"flex",flexDirection:"column",gap:2,overflowY:"auto",flexShrink:0}}>
      <div style={{padding:"0 14px 16px",display:"flex",flexDirection:"column",gap:6}}>
        <div style={{fontFamily:FS,fontSize:15,fontWeight:700,color:T.text,display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
          <span style={{color:T.accent,fontSize:18}}>⌗</span> C Memory Lab
        </div>
        <div style={{display:"flex",gap:4,background:T.surface,borderRadius:6,padding:3}}>
          {["presets","editor"].map(m=>(
            <button key={m} onClick={()=>onMode(m)} style={{flex:1,padding:"6px 0",border:"none",borderRadius:4,background:mode===m?T.accent:"transparent",color:mode===m?T.bg:T.textDim,fontFamily:FS,fontSize:11,fontWeight:600,cursor:"pointer",transition:"all 0.15s"}}>
              {m==="presets"?"📚 Presets":"✏️ Editor"}
            </button>
          ))}
        </div>
      </div>
      {mode==="presets"?(
        <>
          <div style={{fontFamily:F,fontSize:10,fontWeight:700,color:T.textMuted,letterSpacing:2,textTransform:"uppercase",padding:"0 14px 8px"}}>Topics</div>
          {scenarios.map((s,i)=>(
            <button key={s.id} onClick={()=>onSelect(i)} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 14px",border:"none",background:active===i?T.accentDim:"transparent",color:active===i?T.accent:T.textDim,fontFamily:FS,fontSize:12,fontWeight:active===i?600:400,cursor:"pointer",textAlign:"left",borderLeft:active===i?`3px solid ${T.accent}`:"3px solid transparent",transition:"all 0.15s"}}>
              <span style={{fontFamily:F,fontSize:9,color:active===i?T.accent:T.textMuted,width:16}}>{String(i+1).padStart(2,"0")}</span>{s.title}
            </button>
          ))}
        </>
      ):(
        <>
          <div style={{fontFamily:F,fontSize:10,fontWeight:700,color:T.textMuted,letterSpacing:2,textTransform:"uppercase",padding:"0 14px 8px"}}>Examples</div>
          {EXAMPLES.map((ex,i)=>(
            <button key={i} onClick={()=>onSelect(ex.code)} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 14px",border:"none",background:"transparent",color:T.textDim,fontFamily:FS,fontSize:12,cursor:"pointer",textAlign:"left",borderLeft:"3px solid transparent",transition:"all 0.15s"}}
              onMouseEnter={e=>{e.currentTarget.style.color=T.accent;e.currentTarget.style.borderLeftColor=T.accent+"66";}}
              onMouseLeave={e=>{e.currentTarget.style.color=T.textDim;e.currentTarget.style.borderLeftColor="transparent";}}>
              <span style={{fontFamily:F,fontSize:9,color:T.textMuted,width:16}}>▸</span>{ex.label}
            </button>
          ))}
          <div style={{padding:"12px 14px 0"}}>
            <div style={{fontFamily:F,fontSize:9,color:T.textMuted,lineHeight:1.6,padding:"10px 12px",background:T.surface,borderRadius:6,border:`1px solid ${T.border}`}}>
              <div style={{fontWeight:700,marginBottom:4,color:T.textDim}}>Supported:</div>
              int, char, float, double, long, short, unsigned<br/>arrays, pointers, pointer-to-pointer<br/>structs (with padding), enums<br/>#define macros, typedef
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ═══ MAIN ═══
export default function CMemoryVisualizer() {
  const [mode,setMode] = useState("presets");
  const [activeScenario,setActiveScenario] = useState(0);
  const [hc,setHc] = useState(null);
  const [showNotes,setShowNotes] = useState(true);
  const [editorCode,setEditorCode] = useState(EXAMPLES[0].code);
  const [parsed,setParsed] = useState({cells:[],pointers:[]});
  const [errors,setErrors] = useState([]);
  const sc = scenarios[activeScenario];

  useEffect(()=>{setHc(null);},[activeScenario,mode]);
  useEffect(()=>{
    if(mode!=="editor")return;
    try{setParsed(parseCode(editorCode));setErrors([]);}catch(e){setErrors([e.message]);}
  },[editorCode,mode]);

  const handleSide = useCallback((v)=>{if(mode==="presets")setActiveScenario(v);else setEditorCode(v);},[mode]);
  const cc = mode==="presets"?sc.cells:parsed.cells;
  const cp = mode==="presets"?sc.pointers:parsed.pointers;

  return (
    <div style={{display:"flex",height:"100vh",background:T.bg,color:T.text,fontFamily:FS,overflow:"hidden"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:${T.bg}}::-webkit-scrollbar-thumb{background:${T.border};border-radius:3px}textarea{outline:none;resize:none}textarea::selection{background:${T.accent}33}`}</style>
      <SideNav active={activeScenario} onSelect={handleSide} mode={mode} onMode={setMode}/>
      <div style={{flex:1,overflow:"auto",padding:"28px 36px"}}>
        {/* Header */}
        <div style={{marginBottom:28}}>
          {mode==="presets"?(
            <>
              <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:8}}>
                <span style={{fontFamily:F,fontSize:10,color:T.accent,background:T.accentDim,padding:"3px 10px",borderRadius:4,letterSpacing:1}}>{String(activeScenario+1).padStart(2,"0")} / {String(scenarios.length).padStart(2,"0")}</span>
                <div style={{display:"flex",gap:6}}>
                  {["← Prev","Next →"].map((lb,idx)=>{const dis=idx===0?activeScenario===0:activeScenario===scenarios.length-1;return(
                    <button key={lb} onClick={()=>setActiveScenario(idx===0?Math.max(0,activeScenario-1):Math.min(scenarios.length-1,activeScenario+1))} disabled={dis}
                      style={{background:T.surfaceLight,border:`1px solid ${T.border}`,color:dis?T.textMuted:T.text,borderRadius:4,padding:"3px 10px",cursor:dis?"not-allowed":"pointer",fontFamily:F,fontSize:11}}>{lb}</button>
                  );})}
                </div>
              </div>
              <h1 style={{fontFamily:FS,fontSize:26,fontWeight:700,marginBottom:5}}>{sc.title}</h1>
              <p style={{fontFamily:FS,fontSize:13,color:T.textDim,lineHeight:1.5,maxWidth:600}}>{sc.description}</p>
            </>
          ):(
            <>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
                <span style={{fontFamily:F,fontSize:10,color:T.warning,background:T.warning+"22",padding:"3px 10px",borderRadius:4,letterSpacing:1}}>LIVE PARSER</span>
                {parsed.cells.length>0&&<span style={{fontFamily:F,fontSize:10,color:T.textMuted}}>{parsed.cells.filter(c=>c.type!=="padding").length} variable{parsed.cells.filter(c=>c.type!=="padding").length!==1?"s":""} detected</span>}
              </div>
              <h1 style={{fontFamily:FS,fontSize:26,fontWeight:700,marginBottom:5}}>Interactive Code Editor</h1>
              <p style={{fontFamily:FS,fontSize:13,color:T.textDim,lineHeight:1.5,maxWidth:600}}>Write C code below and watch the memory layout update in real-time. Supports basic types, arrays, pointers, structs with padding, and enums.</p>
            </>
          )}
        </div>

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:28,alignItems:"start"}}>
          {/* Left: Code */}
          <div>
            <div style={{fontFamily:F,fontSize:10,color:T.textMuted,letterSpacing:2,textTransform:"uppercase",marginBottom:10}}>{mode==="presets"?"C Code":"C Code Editor"}</div>
            {mode==="presets"?<CodeBlock code={sc.code}/>:(
              <div>
                <div style={{background:"#0d1117",borderRadius:8,border:`1px solid ${errors.length>0?T.danger+"66":T.border}`,overflow:"hidden",transition:"border-color 0.2s"}}>
                  <div style={{display:"flex",minHeight:300}}>
                    <div style={{padding:"14px 0",background:"#0a0f18",borderRight:`1px solid ${T.border}`,userSelect:"none",minWidth:40,textAlign:"right"}}>
                      {editorCode.split("\n").map((_,i)=>(<div key={i} style={{fontFamily:F,fontSize:12,lineHeight:"21.6px",color:T.textMuted,paddingRight:10}}>{i+1}</div>))}
                    </div>
                    <textarea value={editorCode} onChange={e=>setEditorCode(e.target.value)} spellCheck={false}
                      style={{flex:1,padding:"14px 16px",background:"transparent",color:T.text,fontFamily:F,fontSize:12,lineHeight:"21.6px",border:"none",width:"100%",minHeight:300,caretColor:T.accent}}/>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 12px",borderTop:`1px solid ${T.border}`,background:"#080c14"}}>
                    <span style={{fontFamily:F,fontSize:9,color:T.textMuted}}>{editorCode.split("\n").length} lines</span>
                    <button onClick={()=>setEditorCode("")} style={{background:"none",border:`1px solid ${T.border}`,borderRadius:3,color:T.textMuted,fontFamily:F,fontSize:9,padding:"2px 8px",cursor:"pointer"}}
                      onMouseEnter={e=>e.currentTarget.style.color=T.danger} onMouseLeave={e=>e.currentTarget.style.color=T.textMuted}>Clear</button>
                  </div>
                </div>
                {errors.length>0&&<div style={{marginTop:8,padding:"8px 12px",background:T.danger+"15",border:`1px solid ${T.danger}33`,borderRadius:6,fontFamily:F,fontSize:11,color:T.danger}}>{errors.join(", ")}</div>}
              </div>
            )}

            {/* Notes */}
            {mode==="presets"&&sc.notes&&(
              <div style={{marginTop:20}}>
                <button onClick={()=>setShowNotes(!showNotes)} style={{background:"none",border:"none",fontFamily:F,fontSize:10,color:T.textMuted,letterSpacing:2,textTransform:"uppercase",cursor:"pointer",marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
                  <span style={{transform:showNotes?"rotate(90deg)":"rotate(0)",transition:"0.15s",display:"inline-block"}}>▶</span>Key Insights
                </button>
                {showNotes&&(
                  <div style={{display:"flex",flexDirection:"column",gap:8,padding:"12px 16px",background:T.surface,borderRadius:8,border:`1px solid ${T.border}`}}>
                    {sc.notes.map((n,i)=>(<div key={i} style={{display:"flex",gap:8,alignItems:"flex-start"}}><span style={{fontFamily:F,fontSize:10,color:T.accent,marginTop:2}}>▸</span><span style={{fontFamily:FS,fontSize:12,color:T.textDim,lineHeight:1.5}}>{n}</span></div>))}
                  </div>
                )}
              </div>
            )}

            {/* Analysis panel */}
            {mode==="editor"&&parsed.cells.length>0&&(
              <div style={{marginTop:20}}>
                <div style={{fontFamily:F,fontSize:10,color:T.textMuted,letterSpacing:2,textTransform:"uppercase",marginBottom:10}}>Analysis</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  {[
                    {label:"Total Memory",value:(()=>{const l=parsed.cells[parsed.cells.length-1],f=parsed.cells[0];if(!l||!f)return"0 B";const s=parseInt(f.address,16),e=parseInt(l.address,16),m=l.annotation?.match(/(\d+)/);return`${e-s+(m?parseInt(m[1]):4)} bytes`;})(),color:T.accent},
                    {label:"Padding",value:(()=>{let t=0;parsed.cells.forEach(c=>{if(c.type==="padding"){const m=c.annotation?.match(/(\d+)/);if(m)t+=parseInt(m[1]);}});return t>0?`${t} bytes wasted`:"None";})(),color:T.warning},
                    {label:"Pointers",value:`${parsed.pointers.length} ref${parsed.pointers.length!==1?"s":""}`,color:T.info},
                    {label:"Variables",value:`${parsed.cells.filter(c=>c.type!=="padding").length}`,color:T.purple},
                  ].map(({label,value,color})=>(
                    <div key={label} style={{background:T.surface,borderRadius:6,border:`1px solid ${T.border}`,padding:"10px 12px"}}>
                      <div style={{fontFamily:F,fontSize:9,color:T.textMuted,marginBottom:4}}>{label}</div>
                      <div style={{fontFamily:F,fontSize:13,color,fontWeight:600}}>{value}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right: Memory */}
          <LayoutPanel cells={cc} pointers={cp} hc={hc} setHc={setHc}/>
        </div>
      </div>
    </div>
  );
}
