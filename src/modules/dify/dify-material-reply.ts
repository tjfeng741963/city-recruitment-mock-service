import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { difyMediaName, mediaAbsolutePath, type MediaKind } from "../../shared/media-assets.js";
import type { difyContext } from "./dify-context.js";

type Context = NonNullable<ReturnType<typeof difyContext>>;
type Message = { type:"text"; content:string } | { type:MediaKind; name:string; content:string };
type Topic = "work" | "dorm" | "food" | "interview";
type Asset = { id:number; name:string; storage_path:string; sha256:string; kind:MediaKind; position_id:number };
const sharedSubwayAssets = new Map<string,Topic>([
  ["工作内容(1).jpg","work"], ["安检.mp4","work"], ["安检工作","work"], ["地铁宿舍.jpg","dorm"],
]);

function topicFor(text:string):Topic | undefined {
  if (/面试|集合/.test(text)) return "interview";
  if (/宿舍|住宿/.test(text)) return "dorm";
  if (/食堂|餐厅|就餐/.test(text)) return "food";
  if (/工作|岗位|上班|安检/.test(text)) return "work";
  if (/地图|导航|定位/.test(text)) return "interview";
}

function readableAsset(asset:Asset):boolean {
  if (!asset.name.trim() || asset.name.length > 200 || /[\\/:\x00-\x1f【】]|\.\./.test(asset.name) || !difyMediaName(asset)) return false;
  const file=mediaAbsolutePath(asset.storage_path);
  if(!file)return false;
  try{const stat=statSync(file);return stat.isFile() && stat.size>0;}catch{return false;}
}

function mediaFor(db:DatabaseSync, positionId:number, topic:Topic, kind:MediaKind, verticalId:number|null) {
  const subway=verticalId!==null && Boolean(db.prepare(
    "SELECT 1 FROM vertical WHERE id=? AND tenant_id=1 AND code='subway' AND status='enabled'"
  ).get(verticalId));
  const assets=db.prepare(`SELECT id,name,storage_path,sha256,kind,position_id FROM media_assets
    WHERE status='enabled' AND kind=? AND (position_id=? OR position_id=0)
    ORDER BY CASE WHEN position_id=? THEN 0 ELSE 1 END,id`).all(kind,positionId,positionId) as Asset[];
  return assets.find(asset=>{
    if(asset.position_id===0) return subway && sharedSubwayAssets.get(asset.name)===topic && readableAsset(asset);
    return topicFor(asset.name)===topic && readableAsset(asset);
  });
}

function cleanText(value:string) {
  // Text from configured names/addresses must not invoke the Win media parser.
  return value.replace(/【/g,"〔").replace(/】/g,"〕").replace(/https?:\/\/\S+/gi,"").trim().slice(0,500);
}

export function configuredMaterialReply(db:DatabaseSync,positionId:number,query:string,context:Context):Message[] | undefined {
  const question=query.normalize("NFKC").trim();
  if (/(?:不要|不用|不必|别).{0,12}(?:发|给)|取消发送/.test(question)) return;
  const requestsMedia=/发|看|有没有|有无|给我|求|要一[张段]/.test(question)
    && /照片|图片|实拍|图(?:片|吗|$)|视频/.test(question);
  const workAddress = /(?:工作|上班|住宿|宿舍|食堂)(?:地点|地址|定位|地图|导航)/.test(question) && !/面试/.test(question);
  const requestsMap = !workAddress && /发.{0,15}(?:定位|导航|地图|地址)|给.{0,10}(?:定位|导航|地图|地址)|(?:面试|集合).{0,8}(?:定位|地图|导航)(?:呢|吗|[？?]|$)|^(?:定位|发个定位|导航|地图)(?:呢|吗|[？?])?$/.test(question);
  if (!requestsMedia && !requestsMap) return;
  const text=(content:string):Message => ({type:"text",content});
  const topic=requestsMap ? "interview" : topicFor(question);
  if (!topic) return [text("你想看工作、宿舍、食堂，还是面试地点的图片或视频？")];

  const facts=context as Record<string,unknown>;
  const city=String(facts.city || "");
  const otherCity=(db.prepare("SELECT city_name FROM cities WHERE city_name<>?").all(city) as {city_name:string}[])
    .some(row=>row.city_name.length>=2 && question.includes(row.city_name));
  if (otherCity) return [text("请先选择你要咨询的城市和岗位。可以回复「推荐岗位」。")];

  const points=context.interview_points;
  const mentions=points.filter(point=>point.name && question.includes(point.name));
  const point=mentions.length===1 ? mentions[0] : points.length===1 ? points[0] : undefined;
  if (topic==="interview" && !point && points.length>1) {
    return [text("这个岗位有多个面试点，请从岗位面试安排中选一个。可以回复「查看面试安排」。")];
  }
  if (topic==="interview" && !point?.address) return [text("面试地址暂未公布。")];

  const kinds:MediaKind[]=[];
  if (topic==="interview" && points.length===1 && (requestsMap || /照片|图片|实拍|图/.test(question))) kinds.push("image");
  if (topic!=="interview" && /照片|图片|实拍|图/.test(question)) kinds.push("image");
  if (/视频/.test(question)) kinds.push("video");
  const messages:Message[]=[];
  for (const kind of kinds) {
    // The media library currently binds a map image to a position, not to one of
    // several interview points within it.
    if(topic==="interview" && points.length!==1) continue;
    const asset=mediaFor(db,positionId,topic,kind,context.sources.knowledge_vertical_id);
    const name=asset && difyMediaName(asset);
    if (name) messages.push({type:kind,name,content:`${kind==="image"?"图片":"视频"} · ${asset.name}`});
  }
  if (topic==="interview" && point) {
    const name=cleanText(point.name);
    const address=cleanText(point.address);
    if(!address)return [text("面试地址暂未公布。")];
    const source=name && name!==address ? `${name}\n${address}` : address;
    const map=new URL("https://uri.amap.com/search");
    map.searchParams.set("keyword",address.split(/[。\r\n]/,1)[0].trim() || address);
    if (city) map.searchParams.set("city",city);
    map.searchParams.set("callnative","0");
    return [text(requestsMap ? `${source}\n高德地图搜索：${map}` : source),...messages];
  }
  const label=topic==="work"?"工作":topic==="dorm"?"宿舍":"食堂";
  return messages.length ? [text(`这是当前岗位可提供的${label}参考素材。`),...messages]
    : [text(`这边暂无${label}相关的${kinds.length === 2 ? "照片和视频" : kinds[0] === "video" ? "视频" : "照片"}。`)];
}
