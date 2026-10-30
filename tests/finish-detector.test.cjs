const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FinishDetector, decide } = require('../finish-detector.js');
const w=120,h=120;
function image(objects=[]) {
  const pixels = new Uint8ClampedArray(w*h*4);
  for(let i=0;i<w*h;i++) pixels[i*4+3]=255;
  for(const {x,y,size=6,value=220} of objects) for(let yy=y;yy<y+size;yy++) for(let xx=x;xx<x+size;xx++) {
    for(let c=0;c<3;c++) pixels[(yy*w+xx)*4+c]=value;
  }
  return pixels;
}
function detector(options={}) {
  const d=new FinishDetector(w,h,{axis:'horizontal',reverse:false,line:.6,split:.5,margin:.05,threshold:40,minPixels:6,...options});
  for(let i=0;i<20;i++) d.calibrate(image());
  return d;
}
test('red-side crossing is detected by leading edge, only once',()=>{
  const d=detector(); d.process(image([{x:25,y:60}]),1);
  const r=d.process(image([{x:25,y:69}]),1.04);
  assert.deepEqual(r.crossings[0],{before:1,after:1.04}); assert.equal(r.crossings[1],null);
  assert.equal(decide(r.crossings,1.1),null); assert.equal(decide(r.crossings,1.3).winner,'a');
  d.process(image([{x:25,y:60}]),1.4); d.process(image([{x:25,y:69}]),1.5);
  assert.equal(d.crossings[0].after,1.04);
});
test('blue-side crossing and vertical course',()=>{
  const d=detector({axis:'vertical'}); d.process(image([{x:60,y:85}]),1); d.process(image([{x:69,y:85}]),1.04);
  assert.equal(decide(d.crossings,1.3).winner,'b');
});
test('reverse crossing works; motion in wrong direction does not',()=>{
  const d=detector({reverse:true}); d.process(image([{x:25,y:80}]),1); d.process(image([{x:25,y:70}]),1.04);
  assert.ok(d.crossings[0]);
  const wrong=detector(); wrong.process(image([{x:25,y:80}]),1); wrong.process(image([{x:25,y:60}]),1.04);
  assert.equal(wrong.crossings[0],null);
});
test('appearance past the line and stale upstream objects cannot win',()=>{
  const d=detector(); d.process(image([{x:25,y:80}]),1); assert.equal(d.crossings[0],null);
  const stale=detector(); stale.process(image([{x:25,y:60}]),1); stale.process(image([{x:25,y:80}]),2);
  assert.equal(stale.crossings[0],null);
});
test('two balls in one frame require review; disjoint intervals identify winner',()=>{
  const d=detector(); d.process(image([{x:25,y:60},{x:85,y:60}]),1); d.process(image([{x:25,y:69},{x:85,y:69}]),1.04);
  assert.deepEqual(decide(d.crossings,1.1),{winner:null,close:true});
  assert.equal(decide([{before:1,after:1.04},{before:1.08,after:1.12}],1.2).winner,'a');
});
test('background, isolated noise and lane boundaries cannot trigger',()=>{
  const d=detector(); d.process(image(),1); d.process(image([{x:25,y:69,size:1},{x:0,y:69},{x:58,y:69,size:3}]),1.04);
  assert.deepEqual(d.crossings,[null,null]);
});
test('broad lighting change is unstable and cannot award',()=>{
  const d=detector(); const pixels=image(); for(let i=0;i<w*h;i++) for(let c=0;c<3;c++) pixels[i*4+c]=150;
  assert.equal(d.process(pixels,1).unstable,true); assert.deepEqual(d.crossings,[null,null]);
});
