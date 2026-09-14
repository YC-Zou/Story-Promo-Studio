import * as T from './vendor/three.module.min.js';

// Preview-only reconstruction from the supplied character turnaround, not an official rig.
// One renderer is shared between the state panel and waiting panel. No external requests.
const descriptions = {
  empty: '刘看山握着鱼竿，用另一只手招呼创作者，没有成果卡',
  brand: '刘看山持竿静态品牌姿态，没有成果卡',
  fishing: '刘看山安静持竿，轻微调整钓线，等待传播文案',
  'hook-done': '刘看山提起通过蓝色夹扣连接的文案卡，接住后停下',
  success: '刘看山双手整理作品，点头示意完成',
  failure: '刘看山低头检查纸稿，再抬手示意继续',
  export: '刘看山向前递出蓝色作品夹，随后挥手',
  reading: '刘看山捧着书本阅读，书页缓慢翻动',
  storyboard: '刘看山将分镜纸张逐一整理归位',
  drawing: '刘看山移动铅笔，在画板前绘制画面',
  music: '刘看山戴着耳机，轻触耳罩并随节奏点头',
};
const hosts = [...document.querySelectorAll('[data-kanshan]')];
let renderer;
try {
  renderer = new T.WebGLRenderer({antialias:true, alpha:true, powerPreference:'low-power'});
} catch {
  hosts.forEach(host => { host.dataset.render = 'fallback'; });
}
if (renderer) setup();

function setup() {
  renderer.setPixelRatio(Math.min(Math.max(devicePixelRatio,2), 3));
  renderer.setClearColor(0xffffff, 0);
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.domElement.setAttribute('aria-hidden','true');
  renderer.domElement.className = 'kanshan-canvas';
  const scene = new T.Scene();
  const camera = new T.OrthographicCamera(-1.8,1.8,1.8,-1.8,.1,30);
  camera.position.set(0,2.35,8);
  camera.lookAt(0,1.43,0);
  scene.add(new T.HemisphereLight(0xffffff,0xc3cbd8,1.8));
  const key = new T.DirectionalLight(0xffffff,3.1);
  key.position.set(-3,5,5);scene.add(key);
  const rim = new T.DirectionalLight(0xe8f0ff,1.4);
  rim.position.set(4,3,-3);scene.add(rim);
  const white = new T.MeshStandardMaterial({color:0xfdfdfc,roughness:.73});
  const black = new T.MeshStandardMaterial({color:0x161719,roughness:.57});
  const blue = new T.MeshStandardMaterial({color:0x1264dc,roughness:.58});
  const paper = new T.MeshStandardMaterial({color:0xffffff,roughness:.86});
  const pale = new T.MeshStandardMaterial({color:0xcbd7e8,roughness:.82});
  const graphite = new T.MeshStandardMaterial({color:0x7a8ca7,roughness:.7});
  const sphere = new T.SphereGeometry(1,64,48);
  const root = new T.Group(); scene.add(root);
  const upper = new T.Group(); upper.position.y=.56;root.add(upper);
  function ellipsoid(parent,material,x,y,z,sx,sy,sz) {
    const o=new T.Mesh(sphere,material);o.position.set(x,y,z);o.scale.set(sx,sy,sz);parent.add(o);return o;
  }
  function box(parent,material,w,h,d,x=0,y=0,z=0) {
    const o=new T.Mesh(new T.BoxGeometry(w,h,d),material);o.position.set(x,y,z);parent.add(o);return o;
  }
  function rod(parent,material,start,end,r=.045) {
    const a=new T.Vector3(...start),b=new T.Vector3(...end),delta=b.clone().sub(a);
    const o=new T.Mesh(new T.CylinderGeometry(r,r,delta.length(),20),material);
    o.position.copy(a).add(b).multiplyScalar(.5);o.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),delta.normalize());parent.add(o);return o;
  }
  // Continuous, softly tapered white torso, including the head.
  const outline=new T.SplineCurve([
    new T.Vector2(0,0),new T.Vector2(.38,.045),new T.Vector2(.56,.20),
    new T.Vector2(.60,.55),new T.Vector2(.565,1.10),new T.Vector2(.51,1.60),
    new T.Vector2(.43,1.83),new T.Vector2(.25,1.91),new T.Vector2(0,1.93)
  ]);
  const bodyGeometry=new T.LatheGeometry(outline.getPoints(120),128);
  const positions=bodyGeometry.attributes.position;
  for(let i=0;i<positions.count;i++){
    const x=positions.getX(i),y=positions.getY(i),z=positions.getZ(i);
    const top=T.MathUtils.smoothstep(y,1.48,1.9);
    const ears=Math.exp(-Math.pow((x-.32)/.18,2))+Math.exp(-Math.pow((x+.32)/.18,2));
    positions.setY(i,y+.34*ears*Math.exp(-Math.pow(z/.30,2))*top);
  }
  bodyGeometry.computeVertexNormals();
  const body = new T.Mesh(bodyGeometry,white);
  body.scale.z=.81;upper.add(body);
  // Ear tips are sculpted into the torso mesh above, so there is no visible seam.
  const face=new T.Group();upper.add(face);
  ellipsoid(face,black,0,1.48,.56,.285,.255,.265);
  const eyes=[ellipsoid(face,black,-.355,1.49,.35,.039,.055,.022),ellipsoid(face,black,.355,1.49,.35,.039,.055,.022)];
  ellipsoid(upper,white,0,.35,-.54,.22,.23,.22);
  [-1,1].forEach(sign=>{rod(root,black,[sign*.23,.16,0],[sign*.23,.68,0],.075);ellipsoid(root,black,sign*.23,.13,.065,.13,.12,.19)});
  function arm(sign) {
    const joint=new T.Group();joint.position.set(sign*.51,.99,.015);upper.add(joint);
    const curve=new T.CatmullRomCurve3([new T.Vector3(0,0,0),new T.Vector3(sign*.105,-.20,.02),new T.Vector3(sign*.12,-.47,.10)]);
    joint.add(new T.Mesh(new T.TubeGeometry(curve,24,.055,12,false),black));
    const hand=new T.Group();hand.position.set(sign*.12,-.49,.10);joint.add(hand);
    ellipsoid(hand,black,0,-.025,0,.08,.10,.055);
    [-1,0,1].forEach(i=>ellipsoid(hand,black,i*.04,-.105,.01,.027,.06,.027));
    ellipsoid(hand,black,-sign*.07,-.055,.025,.037,.06,.035);
    return {joint,hand};
  }
  const left=arm(-1),right=arm(1);
  // Two-bone arms keep hands attached to actual prop edges, not arbitrary rotations.
  function ikArm(sign,legacy) {
    legacy.joint.visible=false;
    const shoulder=new T.Vector3(sign*.555,.99,.22);
    const upperLimb=ellipsoid(upper,black,0,0,0,.057,.2,.057);
    const lowerLimb=ellipsoid(upper,black,0,0,0,.052,.2,.052);
    const elbowMesh=ellipsoid(upper,black,0,0,0,.055,.055,.055);
    upper.add(legacy.hand);
    upperLimb.visible=false;lowerLimb.visible=false;elbowMesh.visible=false;
    const shoulderCap=ellipsoid(upper,black,shoulder.x,shoulder.y,shoulder.z,.058,.058,.058);
    const limbGeometry=new T.TubeGeometry(new T.LineCurve3(shoulder,shoulder.clone().add(new T.Vector3(0,-.5,0))),40,.055,24,false);
    const limb=new T.Mesh(limbGeometry,black);limb.frustumCulled=false;upper.add(limb);
    return {sign,shoulder,shoulderCap,upperLimb,lowerLimb,elbowMesh,hand:legacy.hand,limb};
  }
  const leftIK=ikArm(-1,left),rightIK=ikArm(1,right);
  const bodyProfile=outline.getPoints(240);
  function bodyRadius(y){
    if(y<0||y>1.93)return 0;
    for(let i=1;i<bodyProfile.length;i++)if(bodyProfile[i].y>=y){const a=bodyProfile[i-1],b=bodyProfile[i];return T.MathUtils.lerp(a.x,b.x,(y-a.y)/Math.max(.0001,b.y-a.y))}
    return 0;
  }
  let minArmClearance=Infinity;
  function setArm(a,target,handZ=0) {
    const wrist=new T.Vector3(...target),elbow=a.shoulder.clone().lerp(wrist,.5);
    elbow.x=a.sign*Math.max(Math.abs(elbow.x)+.12,.65);elbow.z=wrist.z>.45?Math.max(.58,wrist.z*.9):elbow.z-.03;elbow.y-=.03;
    for(const [mesh,p,q] of [[a.upperLimb,a.shoulder,elbow],[a.lowerLimb,elbow,wrist]]){
      const d=q.clone().sub(p);mesh.position.copy(p).add(q).multiplyScalar(.5);mesh.scale.y=d.length()*.57;
      mesh.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),d.normalize());
    }
    a.elbowMesh.position.copy(elbow);a.hand.position.copy(wrist);a.hand.rotation.set(0,0,handZ);
    const curve=new T.QuadraticBezierCurve3(a.shoulder,elbow,wrist),p=a.limb.geometry.attributes.position;
    for(let i=0;i<=40;i++){
      const point=curve.getPoint(i/40),tangent=curve.getTangent(i/40);
      // Keep the full limb radius outside the torso, not only its centerline.
      const radius=bodyRadius(point.y)+.064;
      if(Math.abs(point.x)<radius)point.z=Math.max(point.z,Math.sqrt(radius*radius-point.x*point.x)*.81+.01);
      if(i===0)a.shoulderCap.position.copy(point);
      minArmClearance=Math.min(minArmClearance,Math.hypot(point.x,point.z/.81)-bodyRadius(point.y)-.055);
      const u=new T.Vector3().crossVectors(tangent,new T.Vector3(0,0,1)).normalize(),v=new T.Vector3().crossVectors(tangent,u).normalize();
      for(let j=0;j<=24;j++){const angle=j/24*Math.PI*2,r=.055-i/40*.005;const q=point.clone().addScaledVector(u,Math.cos(angle)*r).addScaledVector(v,Math.sin(angle)*r);p.setXYZ(i*25+j,q.x,q.y,q.z)}
    }
    p.needsUpdate=true;a.limb.geometry.computeVertexNormals();
  }
  // A stable soft contact shadow, without a heavy shadow-map pass.
  const shadowCanvas=document.createElement('canvas');shadowCanvas.width=128;shadowCanvas.height=128;
  const ctx=shadowCanvas.getContext('2d');const gradient=ctx.createRadialGradient(64,64,4,64,64,64);
  gradient.addColorStop(0,'rgba(40,56,75,.20)');gradient.addColorStop(1,'rgba(40,56,75,0)');ctx.fillStyle=gradient;ctx.fillRect(0,0,128,128);
  const shadow=new T.Mesh(new T.PlaneGeometry(1.9,1.1),new T.MeshBasicMaterial({map:new T.CanvasTexture(shadowCanvas),transparent:true,depthWrite:false}));
  shadow.rotation.x=-Math.PI/2;shadow.position.y=.005;scene.add(shadow);
  const bundle=new T.Group();upper.add(bundle);
  box(bundle,blue,.84,.60,.07,0,0,0);
  for(let i=0;i<3;i++)box(bundle,paper,.77,.54,.022,0,.025+i*.006,.05+i*.025);
  const clip=box(bundle,graphite,.12,.07,.07,0,.30,.07);
  for(let i=0;i<3;i++)box(bundle,pale,.40-i*.06,.015,.006,-.06,.12-i*.095,.114);
  const sheet=new T.Group();upper.add(sheet);
  box(sheet,paper,.64,.77,.025);
  for(let i=0;i<4;i++)box(sheet,pale,.43-i*.035,.013,.006,0,.20-i*.115,.02);
  const book=new T.Group();upper.add(book);
  const bookLeft=new T.Group(),bookRight=new T.Group();book.add(bookLeft,bookRight);
  box(bookLeft,blue,.43,.59,.045,-.215,0,0);box(bookLeft,paper,.39,.54,.05,-.21,.01,.04);
  box(bookRight,blue,.43,.59,.045,.215,0,0);box(bookRight,paper,.39,.54,.05,.21,.01,.04);
  bookLeft.rotation.y=.2;bookRight.rotation.y=-.2;
  const pageTurn=new T.Group();pageTurn.position.z=.14;book.add(pageTurn);box(pageTurn,paper,.40,.54,.008,.20,.01,0);
  const table=new T.Group();root.add(table);
  box(table,paper,1.4,.065,.55,0,1.02,1.02);
  [-.57,.57].forEach(x=>rod(table,pale,[x,.06,1.02],[x,1,1.02],.035));
  const cards=[];
  for(let i=0;i<3;i++){const card=new T.Group();card.position.set((i-1)*.40,1.063,1.02);table.add(card);box(card,paper,.34,.012,.43);box(card,pale,.25,.003,.22,0,.010,0);cards.push(card)}
  const drawing=new T.Group();root.add(drawing);
  drawing.position.set(1.12,.95,.40);drawing.rotation.y=0;
  box(drawing,pale,.70,.94,.07,0,.33,0);box(drawing,paper,.64,.86,.02,0,.33,.05);
  [-.30,.30].forEach(x=>rod(drawing,pale,[x,-.9,0],[x,.86,0],.032));
  const sketch=new T.CatmullRomCurve3([new T.Vector3(-.18,.18,.076),new T.Vector3(-.07,.33,.076),new T.Vector3(.08,.38,.076),new T.Vector3(.18,.53,.076)]);
  drawing.add(new T.Mesh(new T.TubeGeometry(sketch,36,.009,8,false),blue));
  const pencil=new T.Group();root.add(pencil);
  const pencilShaft=new T.Mesh(new T.CylinderGeometry(.021,.021,1,24),blue);pencil.add(pencilShaft);
  const pencilTip=new T.Mesh(new T.ConeGeometry(.021,.055,24),graphite);pencil.add(pencilTip);
  let drawingWrist=[.8,.7,.82],pencilContactError=0;
  const headphones=new T.Group();upper.add(headphones);
  const headphoneBand=new T.CatmullRomCurve3([new T.Vector3(-.62,1.55,0),new T.Vector3(-.65,1.85,-.42),new T.Vector3(0,1.98,-.61),new T.Vector3(.65,1.85,-.42),new T.Vector3(.62,1.55,0)]);
  headphones.add(new T.Mesh(new T.TubeGeometry(headphoneBand,48,.032,12,false),blue));
  [-1,1].forEach(s=>ellipsoid(headphones,blue,s*.60,1.56,.005,.095,.17,.14));
  const fishing=new T.Group();upper.add(fishing);
  const grip=new T.Group();grip.position.set(.64,.72,.45);fishing.add(grip);
  const poleCurve=new T.CatmullRomCurve3([new T.Vector3(0,-.16,0),new T.Vector3(.20,.46,0),new T.Vector3(.39,.99,0),new T.Vector3(.60,1.32,0)]);
  grip.add(new T.Mesh(new T.TubeGeometry(poleCurve,40,.017,10,false),blue));
  rod(grip,black,[0,-.17,0],[.065,.14,0],.029);
  ellipsoid(grip,blue,.02,.04,.06,.057,.057,.024);
  const linePositions=new Float32Array(33*3);
  const lineGeometry=new T.BufferGeometry();lineGeometry.setAttribute('position',new T.BufferAttribute(linePositions,3));
  const fishingLine=new T.Line(lineGeometry,new T.LineBasicMaterial({color:0x667e9e,transparent:true,opacity:.85}));fishingLine.frustumCulled=false;fishing.add(fishingLine);
  const hookCard=new T.Group();fishing.add(hookCard);
  box(hookCard,blue,.47,.56,.025);box(hookCard,paper,.43,.52,.018,0,0,.018);
  box(hookCard,blue,.10,.055,.05,0,.28,.04);
  for(let i=0;i<3;i++)box(hookCard,pale,.29-i*.035,.016,.005,-.025,.10-i*.09,.03);
  const connector=new T.Mesh(new T.TorusGeometry(.033,.009,8,24),blue);connector.position.set(0,.33,.02);hookCard.add(connector);
  const bareHook=new T.Group();fishing.add(bareHook);
  const hookCurve=new T.CatmullRomCurve3([new T.Vector3(0,.06,0),new T.Vector3(0,-.035,0),new T.Vector3(.04,-.055,0),new T.Vector3(.065,-.018,0)]);
  bareHook.add(new T.Mesh(new T.TubeGeometry(hookCurve,16,.009,8,false),blue));
  const props=[bundle,sheet,book,table,drawing,pencil,headphones,fishing];
  const smooth=(a,b,x)=>{const t=T.MathUtils.clamp((x-a)/(b-a),0,1);return t*t*(3-2*t)};
  const pulse=(t,a,b)=>Math.sin(Math.PI*T.MathUtils.clamp((t-a)/(b-a),0,1));
  function pose(mode,time) {
    minArmClearance=Infinity;pencilContactError=0;
    const t=['hook-done','empty','success','export','brand'].includes(mode)?Math.min(time,5.8):time%5.8, wave=Math.sin(t*7);
    root.rotation.set(0,-.07,0);upper.rotation.set(0,0,0);upper.position.set(0,.56,0);
    left.joint.rotation.set(0,0,-.08);right.joint.rotation.set(0,0,.08);
    left.hand.rotation.set(0,0,0);right.hand.rotation.set(0,0,0);
    props.forEach(p=>p.visible=false);eyes.forEach(e=>e.scale.y=.055);
    bundle.position.set(0,.58,.65);bundle.rotation.set(-.16,0,0);
    sheet.position.set(-.10,.67,.64);sheet.rotation.set(-.3,0,-.08);
    book.position.set(0,.62,.65);book.rotation.set(-.22,0,0);
    if(mode==='empty') {
      const lift=smooth(.2,.9,t)*(1-smooth(3.3,4.0,t));
      right.joint.rotation.z=lift*2.55;
      right.hand.rotation.z=lift*wave*.24;
      upper.rotation.z=-lift*.035;
    } else if(mode==='success') {
      bundle.visible=true;left.joint.rotation.x=-.95;right.joint.rotation.x=-.95;
      left.joint.rotation.z=-.4;right.joint.rotation.z=.4;
      const tap=pulse(t,.4,1.1)+pulse(t,1.25,1.85);
      bundle.position.y+=tap*.055;left.joint.rotation.x-=tap*.09;right.joint.rotation.x-=tap*.09;
      upper.rotation.x=pulse(t,2.2,3.4)*.09;
    } else if(mode==='failure') {
      sheet.visible=true;left.joint.rotation.set(-1.12,0,-.2);
      upper.rotation.x=.12*pulse(t,.3,2.8);upper.rotation.z=.055*pulse(t,.3,2.8);
      const explain=pulse(t,3,5.2);right.joint.rotation.set(-.35*explain,0,1.1*explain);
      right.hand.rotation.y=explain*.6;
    } else if(mode==='export') {
      bundle.visible=true;const offer=smooth(.3,1.6,t)*(1-smooth(4.7,5.7,t));
      left.joint.rotation.set(-1.05-offer*.28,0,-.32);right.joint.rotation.set(-1.05,0,.32);
      bundle.position.z+=offer*.25;bundle.rotation.x-=offer*.12;
      const bye=pulse(t,2.2,4.6);right.joint.rotation.x*=1-bye;right.joint.rotation.z+=bye*2.2;right.hand.rotation.z=bye*wave*.17;
    } else if(mode==='reading') {
      book.visible=true;left.joint.rotation.set(-1.1,0,-.3);right.joint.rotation.set(-1.1,0,.3);
      upper.rotation.x=.06;upper.rotation.y=Math.sin(time*.8)*.035;
      pageTurn.rotation.y=-Math.PI*smooth(1.2,3.4,t)*(1-smooth(4.2,5.6,t));
    } else if(mode==='storyboard') {
      table.visible=true;left.joint.rotation.x=-1.15;right.joint.rotation.x=-1.3;
      const sort=pulse(t,.5,3.5);right.joint.rotation.z=-sort*.45;
      cards[2].position.x=.4-sort*.18;cards[2].position.y=1.063+sort*.04;cards[2].rotation.y=sort*.12;
      upper.rotation.x=0;
    } else if(mode==='drawing') {
      drawing.visible=true;pencil.visible=true;root.rotation.y=0;
      const tip=sketch.getPoint(.5-.5*Math.cos(time*1.6)).add(drawing.position);
      drawingWrist=[.80,tip.y-.56-.08,.84];
      const held=new T.Vector3(drawingWrist[0],drawingWrist[1]+.56-.045,drawingWrist[2]-.02);
      const direction=tip.clone().sub(held).normalize(),base=held.clone().addScaledVector(direction,-.12),length=base.distanceTo(tip);
      pencil.position.copy(base);pencil.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),direction);
      pencilShaft.scale.y=length-.055;pencilShaft.position.y=(length-.055)/2;pencilTip.position.y=length-.0275;
      pencilContactError=base.clone().addScaledVector(direction,length).distanceTo(tip);
    } else if(mode==='music') {
      headphones.visible=true;right.joint.rotation.z=2.9;right.joint.rotation.x=-.18;
      upper.rotation.x=Math.sin(time*2)*.035;
    }
    if(t>4.9&&t<5.08)eyes.forEach(e=>e.scale.y=.014);
    let l=[-.64,.45,.1],r=[.64,.45,.1],rz=0;
    if(mode==='empty'){
      const lift=smooth(.2,.9,t)*(1-smooth(3.3,4,t));
      r=[.64+lift*.19,.45+lift*1.12,.1+lift*.04];rz=lift*(Math.PI+wave*.20);
    }else if(mode==='success'){
      l=propGrip(bundle,[-.42,.12,.20]);r=propGrip(bundle,[.42,.12,.20]);
    }else if(mode==='failure'){
      l=propGrip(sheet,[-.32,.09,.12]);const explain=pulse(t,3,5.2);r=[.68+explain*.13,.45+explain*.30,.24+explain*.22];rz=explain*1.5;
    }else if(mode==='export'){
      l=propGrip(bundle,[-.42,.12,.20]);const bye=pulse(t,2.2,4.6),hold=propGrip(bundle,[.42,.12,.20]);
      r=[hold[0]+bye*.38,hold[1]+bye*.95,hold[2]-bye*.60];rz=bye*(Math.PI+wave*.17);
    }else if(mode==='reading'){
      l=propGrip(book,[-.43,.13,.16]);r=propGrip(book,[.43,.13,.16]);
    }else if(mode==='storyboard'){
      l=[-.50,.69,1.05];const sort=pulse(t,.5,3.5);r=[cards[2].position.x,.69+sort*.04,1.05];
    }else if(mode==='drawing'){
      l=[-.65,.5,.24];r=drawingWrist;rz=-.18;
    }else if(mode==='music'){
      r=[.72,1.63,.21];rz=0;
    }
    if(['empty','brand','fishing','hook-done'].includes(mode)){
      fishing.visible=true;root.rotation.y=-.08;
      const done=mode==='hook-done',lift=done?smooth(.3,2.8,t):0,catchCard=done?smooth(2.8,4.6,t):0;
      grip.rotation.z=done?lift*.16:mode==='fishing'?Math.sin(time*.9)*.025:0;
      const tip=new T.Vector3(.6,1.32,0).applyEuler(grip.rotation).add(grip.position);
      hookCard.visible=done;bareHook.visible=!done;
      hookCard.position.set(1.24-catchCard*.94,-.94+lift*1.29+catchCard*.20,.45+catchCard*.15);
      hookCard.rotation.z=done?(1-catchCard)*Math.sin(t*2)*.035:0;
      const end=done?hookCard.position.clone().add(new T.Vector3(0,.33,.02)):new T.Vector3(1.24+Math.sin(time*.8)*.025,-.38,.45);
      bareHook.position.copy(end);
      const middle=tip.clone().lerp(end,.5);middle.x+=catchCard*.14;
      const rope=new T.QuadraticBezierCurve3(tip,middle,end);
      for(let i=0;i<33;i++){const p=rope.getPoint(i/32);linePositions[i*3]=p.x;linePositions[i*3+1]=p.y;linePositions[i*3+2]=p.z}
      lineGeometry.attributes.position.needsUpdate=true;
      r=[.65,.72,.55];rz=0;
      l=[-.64,.45,.1];
      if(mode==='empty'){
        const hello=smooth(.3,.9,t)*(1-smooth(2.2,3,t));l=[-.64-hello*.13,.45+hello*.65,.1];
        leftIK.hand.rotation.z=hello*2;
      }
      if(done)l=[-.64+catchCard*.71,.45+catchCard*.13,.24+catchCard*.47];
    }
    setArm(leftIK,l);setArm(rightIK,r,rz);
  }
  function propGrip(prop,point){return new T.Vector3(...point).applyEuler(prop.rotation).add(prop.position).toArray()}
  const stillTimes={brand:0,empty:1.4,fishing:1.5,'hook-done':5.8,success:2.7,failure:1.6,export:3.3,reading:2,storyboard:1.8,drawing:1,music:1.3};
  const oneShot=new Set(['empty','hook-done','success','export','brand']);
  const playback=new WeakMap();
  let frame=0,active=null,last=0,clock=0,mode='',visible=true,lastSize=0;
  function render(host,t) {
    if(!host)return;
    if(renderer.domElement.parentElement!==host)host.append(renderer.domElement);
    hosts.forEach(h=>h.classList.toggle('has-live-canvas',h===host));
    const size=Math.max(1,host.clientWidth);
    if(size!==lastSize){renderer.setSize(size,size,false);lastSize=size}
    pose(host.dataset.kanshan,t);renderer.render(scene,camera);
    host.dataset.frame=String(Math.round(t*1000));
    host.dataset.motionEnded=String(oneShot.has(host.dataset.kanshan)&&t>=5.8);
    if(new URLSearchParams(location.search).has('motion-review'))host.dataset.geometryCheck=JSON.stringify({minArmClearance,pencilContactError,pixelRatio:renderer.getPixelRatio(),antialias:renderer.getContext().getContextAttributes().antialias});
    playback.set(host,{mode:host.dataset.kanshan,time:t});
  }
  function shouldMove(){return !document.documentElement.classList.contains('motion-paused')&&!document.hidden}
  function choose(){
    return hosts.filter(h=>{const r=h.getBoundingClientRect();return r.top<innerHeight&&r.bottom>64&&h.offsetWidth>0}).sort((a,b)=>{
      const score=h=>{const r=h.getBoundingClientRect();return Math.min(innerHeight,r.bottom)-Math.max(64,r.top)};return score(b)-score(a)
    })[0]||null;
  }
  function tick(now){
    frame=0;if(!active||!visible||!shouldMove())return;
    if(oneShot.has(mode)&&clock>=5.8)return;
    if(now-last>=1000/30){clock+=Math.min((now-last)/1000,.08);if(oneShot.has(mode))clock=Math.min(clock,5.8);last=now;render(active,clock)}
    frame=requestAnimationFrame(tick);
  }
  function sync(){
    const chosen=choose();
    if(chosen!==active||chosen?.dataset.kanshan!==mode){active=chosen;mode=chosen?.dataset.kanshan||'';const saved=chosen&&playback.get(chosen);clock=saved?.mode===mode?saved.time:shouldMove()?0:(stillTimes[mode]??1);last=performance.now()}
    cancelAnimationFrame(frame);frame=0;
    if(active){render(active,clock);if(shouldMove())frame=requestAnimationFrame(tick)}
  }
  const observer=new IntersectionObserver(sync,{threshold:[0,.1,.25,.5,.75,1]});hosts.forEach(h=>observer.observe(h));
  const resize=new ResizeObserver(sync);hosts.forEach(h=>resize.observe(h));
  const mutations=new MutationObserver(sync);
  mutations.observe(document.documentElement,{attributes:true,attributeFilter:['class']});
  hosts.forEach(h=>mutations.observe(h,{attributes:true,attributeFilter:['data-kanshan']}));
  document.addEventListener('visibilitychange',sync);
  window.addEventListener('kanshan-replay',()=>{clock=0;last=performance.now();sync()});
  // Deterministic keyframe inspection is available only in the explicit review URL.
  if(new URLSearchParams(location.search).has('motion-review'))window.addEventListener('kanshan-review-time',e=>{
    if(!active||!Number.isFinite(e.detail))return;cancelAnimationFrame(frame);frame=0;clock=Math.max(0,Math.min(5.8,e.detail));render(active,clock);
  });
  renderer.domElement.addEventListener('webglcontextlost',event=>{
    event.preventDefault();visible=false;cancelAnimationFrame(frame);hosts.forEach(h=>h.classList.remove('has-live-canvas'));
  });
  renderer.domElement.addEventListener('webglcontextrestored',()=>{visible=true;sync()});
  window.addEventListener('pagehide',()=>{
    cancelAnimationFrame(frame);observer.disconnect();resize.disconnect();mutations.disconnect();
    const geometries=new Set(),materials=new Set();scene.traverse(o=>{if(o.geometry)geometries.add(o.geometry);if(o.material)materials.add(o.material)});
    geometries.forEach(g=>g.dispose());materials.forEach(m=>{m.map?.dispose();m.dispose()});renderer.dispose();
  },{once:true});
  // Initial static rendering is also used when the system requests reduced motion.
  hosts.forEach(h=>h.setAttribute('aria-label',descriptions[h.dataset.kanshan]||'刘看山创作搭档'));
  window.addEventListener('kanshan-state',()=>{hosts.forEach(h=>h.setAttribute('aria-label',descriptions[h.dataset.kanshan]||'刘看山创作搭档'));sync()});
  sync();
}
