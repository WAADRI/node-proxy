import{K as be,L as xt,a as de,N as W,Q as D,R as he,U as Re,o as c,c as C,W as M,F as ae,V as S,a4 as G,ak as At,q as Ne,X as Xe,by as wn,aR as Lt,a0 as Ye,z as P,ap as ee,af as $e,p as I,a2 as it,ag as Ct,E as Se,aL as Ie,bz as zt,bA as Dt,bB as Vt,f as Ze,bC as xn,a_ as Cn,ar as yt,b5 as qe,bh as kn,bD as rt,a9 as ie,aH as kt,bE as Sn,O as ne,T as _e,aV as at,bF as Rn,$ as St,a3 as we,bG as zn,bH as Ve,bI as Ft,a1 as Fn,bJ as vt,v as Ee,y as Nt,bK as De,bL as Rt,bi as Wt,bd as Kt,b0 as Tn,aQ as Mn,bM as On,ai as Ge,b7 as In,bN as Pn,bO as Bn,bP as _n,bQ as $n,P as En,bR as An,aS as Ln,aP as wt,b as Dn,a5 as Oe,bS as Vn,Y as Tt,aU as Nn,bT as Wn,bU as Kn,bV as jn,aA as Un,bW as Hn,a6 as qn,aa as Gn,bX as Mt,bY as Xn,bZ as Yn,aI as Zn}from"./index-CIR41uTa.js";var Qn=be({name:"Empty",render(){return(()=>{const e=xt("15c1a247ae156450");return e[0]||(e[0]=de("svg",{viewBox:"0 0 28 28",fill:"none",xmlns:"http://www.w3.org/2000/svg"},[de("path",{d:"M26 7.5C26 11.0899 23.0899 14 19.5 14C15.9101 14 13 11.0899 13 7.5C13 3.91015 15.9101 1 19.5 1C23.0899 1 26 3.91015 26 7.5ZM16.8536 4.14645C16.6583 3.95118 16.3417 3.95118 16.1464 4.14645C15.9512 4.34171 15.9512 4.65829 16.1464 4.85355L18.7929 7.5L16.1464 10.1464C15.9512 10.3417 15.9512 10.6583 16.1464 10.8536C16.3417 11.0488 16.6583 11.0488 16.8536 10.8536L19.5 8.20711L22.1464 10.8536C22.3417 11.0488 22.6583 11.0488 22.8536 10.8536C23.0488 10.6583 23.0488 10.3417 22.8536 10.1464L20.2071 7.5L22.8536 4.85355C23.0488 4.65829 23.0488 4.34171 22.8536 4.14645C22.6583 3.95118 22.3417 3.95118 22.1464 4.14645L19.5 6.79289L16.8536 4.14645Z",fill:"currentColor"}),de("path",{d:"M25 22.75V12.5991C24.5572 13.0765 24.053 13.4961 23.5 13.8454V16H17.5L17.3982 16.0068C17.0322 16.0565 16.75 16.3703 16.75 16.75C16.75 18.2688 15.5188 19.5 14 19.5C12.4812 19.5 11.25 18.2688 11.25 16.75L11.2432 16.6482C11.1935 16.2822 10.8797 16 10.5 16H4.5V7.25C4.5 6.2835 5.2835 5.5 6.25 5.5H12.2696C12.4146 4.97463 12.6153 4.47237 12.865 4H6.25C4.45507 4 3 5.45507 3 7.25V22.75C3 24.5449 4.45507 26 6.25 26H21.75C23.5449 26 25 24.5449 25 22.75ZM4.5 22.75V17.5H9.81597L9.85751 17.7041C10.2905 19.5919 11.9808 21 14 21L14.215 20.9947C16.2095 20.8953 17.842 19.4209 18.184 17.5H23.5V22.75C23.5 23.7165 22.7165 24.5 21.75 24.5H6.25C5.2835 24.5 4.5 23.7165 4.5 22.75Z",fill:"currentColor"})],-1))})()}}),Jn=W("empty",`
 display: flex;
 flex-direction: column;
 align-items: center;
 font-size: var(--n-font-size);
`,[D("icon",`
 width: var(--n-icon-size);
 height: var(--n-icon-size);
 font-size: var(--n-icon-size);
 line-height: var(--n-icon-size);
 color: var(--n-icon-color);
 transition:
 color .3s var(--n-bezier);
 `,[he("+",[D("description",`
 margin-top: 8px;
 `)])]),D("description",`
 transition: color .3s var(--n-bezier);
 color: var(--n-text-color);
 `),D("extra",`
 text-align: center;
 transition: color .3s var(--n-bezier);
 margin-top: 12px;
 color: var(--n-extra-text-color);
 `)]);const eo={...Re.props,description:String,showDescription:{type:Boolean,default:!0},showIcon:{type:Boolean,default:!0},size:{type:String,default:"medium"},renderIcon:Function};var to=be({name:"Empty",props:eo,slots:Object,setup(e){const{mergedClsPrefixRef:t,inlineThemeDisabled:o,mergedComponentPropsRef:l}=Xe(e),i=Re("Empty","-empty",Jn,wn,e,t),{localeRef:d}=Lt("Empty"),u=P(()=>{var b,w;return e.description??((w=(b=l==null?void 0:l.value)==null?void 0:b.Empty)==null?void 0:w.description)}),r=P(()=>{var b,w;return((w=(b=l==null?void 0:l.value)==null?void 0:b.Empty)==null?void 0:w.renderIcon)||(()=>(c(),G(Qn)))}),k=P(()=>{const{size:b}=e,{common:{cubicBezierEaseInOut:w},self:{[ee("iconSize",b)]:$,[ee("fontSize",b)]:T,textColor:g,iconColor:p,extraTextColor:O}}=i.value;return{"--n-icon-size":$,"--n-font-size":T,"--n-bezier":w,"--n-text-color":g,"--n-icon-color":p,"--n-extra-text-color":O}}),f=o?Ye("empty",P(()=>{let b="";const{size:w}=e;return b+=w[0],b}),k,e):void 0;return{mergedClsPrefix:t,mergedRenderIcon:r,localizedDescription:P(()=>u.value||d.value.description),cssVars:o?void 0:k,themeClass:f==null?void 0:f.themeClass,onRender:f==null?void 0:f.onRender}},render(){const{$slots:e,mergedClsPrefix:t,onRender:o}=this;return o==null||o(),c(),C("div",{class:M([`${t}-empty`,this.themeClass]),style:Ne(this.cssVars)},[this.showIcon?(c(),C("div",{key:0,class:M(`${t}-empty__icon`)},[e.icon?(c(),C(ae,{key:0},[S(()=>e.icon())],64)):(c(),G(At,{key:1,clsPrefix:t},{default:this.mergedRenderIcon},1032,["clsPrefix"]))],2)):S(()=>null),this.showDescription?(c(),C("div",{key:2,class:M(`${t}-empty__description`)},[e.default?(c(),C(ae,{key:0},[S(()=>e.default())],64)):(c(),C(ae,{key:1},[S(()=>this.localizedDescription)],64))],2)):S(()=>null),e.extra?(c(),C("div",{key:4,class:M(`${t}-empty__extra`)},[S(()=>e.extra())],2)):S(()=>null)],6)}});function Ot(e){return e&-e}class jt{constructor(t,o){this.l=t,this.min=o;const l=new Array(t+1);for(let i=0;i<t+1;++i)l[i]=0;this.ft=l}add(t,o){if(o===0)return;const{l,ft:i}=this;for(t+=1;t<=l;)i[t]+=o,t+=Ot(t)}get(t){return this.sum(t+1)-this.sum(t)}sum(t){if(t===void 0&&(t=this.l),t<=0)return 0;const{ft:o,min:l,l:i}=this;if(t>i)throw new Error("[FinweckTree.sum]: `i` is larger than length.");let d=t*l;for(;t>0;)d+=o[t],t-=Ot(t);return d}getBound(t){let o=0,l=this.l;for(;l>o;){const i=Math.floor((o+l)/2),d=this.sum(i);if(d>t){l=i;continue}else if(d<t){if(o===i)return this.sum(o+1)<=t?o+1:i;o=i}else return i}return o}}let lt;function no(){return typeof document>"u"?!1:(lt===void 0&&("matchMedia"in window?lt=window.matchMedia("(pointer:coarse)").matches:lt=!1),lt)}let gt;function It(){return typeof document>"u"?1:(gt===void 0&&(gt="chrome"in window?window.devicePixelRatio:1),gt)}const Ut="VVirtualListXScroll";function oo({columnsRef:e,renderColRef:t,renderItemWithColsRef:o}){const l=I(0),i=I(0),d=P(()=>{const f=e.value;if(f.length===0)return null;const b=new jt(f.length,0);return f.forEach((w,$)=>{b.add($,w.width)}),b}),u=$e(()=>{const f=d.value;return f!==null?Math.max(f.getBound(i.value)-1,0):0}),r=f=>{const b=d.value;return b!==null?b.sum(f):0},k=$e(()=>{const f=d.value;return f!==null?Math.min(f.getBound(i.value+l.value)+1,e.value.length-1):0});return it(Ut,{startIndexRef:u,endIndexRef:k,columnsRef:e,renderColRef:t,renderItemWithColsRef:o,getLeft:r}),{listWidthRef:l,scrollLeftRef:i}}const Pt=be({name:"VirtualListRow",props:{index:{type:Number,required:!0},item:{type:Object,required:!0}},setup(){const{startIndexRef:e,endIndexRef:t,columnsRef:o,getLeft:l,renderColRef:i,renderItemWithColsRef:d}=Ct(Ut);return{startIndex:e,endIndex:t,columns:o,renderCol:i,renderItemWithCols:d,getLeft:l}},render(){const{startIndex:e,endIndex:t,columns:o,renderCol:l,renderItemWithCols:i,getLeft:d,item:u}=this;if(i!=null)return i({itemIndex:this.index,startColIndex:e,endColIndex:t,allColumns:o,item:u,getLeft:d});if(l!=null){const r=[];for(let k=e;k<=t;++k){const f=o[k];r.push(l({column:f,left:d(k),item:u}))}return r}return null}}),lo=rt(".v-vl",{maxHeight:"inherit",height:"100%",overflow:"auto",minWidth:"1px"},[rt("&:not(.v-vl--show-scrollbar)",{scrollbarWidth:"none"},[rt("&::-webkit-scrollbar, &::-webkit-scrollbar-track-piece, &::-webkit-scrollbar-thumb",{width:0,height:0,display:"none"})])]),ro=be({name:"VirtualList",inheritAttrs:!1,props:{showScrollbar:{type:Boolean,default:!0},columns:{type:Array,default:()=>[]},renderCol:Function,renderItemWithCols:Function,items:{type:Array,default:()=>[]},itemSize:{type:Number,required:!0},itemResizable:Boolean,itemsStyle:[String,Object],visibleItemsTag:{type:[String,Object],default:"div"},visibleItemsProps:Object,ignoreItemResize:Boolean,onScroll:Function,onWheel:Function,onResize:Function,defaultScrollKey:[Number,String],defaultScrollIndex:Number,keyField:{type:String,default:"key"},paddingTop:{type:[Number,String],default:0},paddingBottom:{type:[Number,String],default:0}},setup(e){const t=Dt();lo.mount({id:"vueuc/virtual-list",head:!0,anchorMetaName:Vt,ssr:t}),Ze(()=>{const{defaultScrollIndex:v,defaultScrollKey:x}=e;v!=null?O({index:v}):x!=null&&O({key:x})});let o=!1,l=!1;xn(()=>{if(o=!1,!l){l=!0;return}O({top:T.value,left:u.value})}),Cn(()=>{o=!0,l||(l=!0)});const i=$e(()=>{if(e.renderCol==null&&e.renderItemWithCols==null||e.columns.length===0)return;let v=0;return e.columns.forEach(x=>{v+=x.width}),v}),d=P(()=>{const v=new Map,{keyField:x}=e;return e.items.forEach((N,A)=>{v.set(N[x],A)}),v}),{scrollLeftRef:u,listWidthRef:r}=oo({columnsRef:ie(e,"columns"),renderColRef:ie(e,"renderCol"),renderItemWithColsRef:ie(e,"renderItemWithCols")}),k=I(null),f=I(void 0),b=new Map,w=P(()=>{const{items:v,itemSize:x,keyField:N}=e,A=new jt(v.length,x);return v.forEach((Z,Y)=>{const j=Z[N],Q=b.get(j);Q!==void 0&&A.add(Y,Q)}),A}),$=I(0),T=I(0),g=$e(()=>Math.max(w.value.getBound(T.value-yt(e.paddingTop))-1,0)),p=P(()=>{const{value:v}=f;if(v===void 0)return[];const{items:x,itemSize:N}=e,A=g.value,Z=Math.min(A+Math.ceil(v/N+1),x.length-1),Y=[];for(let j=A;j<=Z;++j)Y.push(x[j]);return Y}),O=(v,x)=>{if(typeof v=="number"){U(v,x,"auto");return}const{left:N,top:A,index:Z,key:Y,position:j,behavior:Q,debounce:q=!0}=v;if(N!==void 0||A!==void 0)U(N,A,Q);else if(Z!==void 0)E(Z,Q,q);else if(Y!==void 0){const se=d.value.get(Y);se!==void 0&&E(se,Q,q)}else j==="bottom"?U(0,Number.MAX_SAFE_INTEGER,Q):j==="top"&&U(0,0,Q)};let F,R=null;function E(v,x,N){const A=k.value;if(A==null)return;const{value:Z}=w,Y=Z.sum(v)+yt(e.paddingTop);if(!N)A.scrollTo({left:0,top:Y,behavior:x});else{F=v,R!==null&&window.clearTimeout(R),R=window.setTimeout(()=>{F=void 0,R=null},16);const{scrollTop:j,offsetHeight:Q}=A;if(Y>j){const q=Z.get(v);Y+q<=j+Q||A.scrollTo({left:0,top:Y+q-Q,behavior:x})}else A.scrollTo({left:0,top:Y,behavior:x})}}function U(v,x,N){const A=k.value;A!=null&&A.scrollTo({left:v,top:x,behavior:N})}function H(v,x){var N,A,Z;if(o||e.ignoreItemResize||X(x.target))return;const{value:Y}=w,j=d.value.get(v),Q=Y.get(j),q=(Z=(A=(N=x.borderBoxSize)===null||N===void 0?void 0:N[0])===null||A===void 0?void 0:A.blockSize)!==null&&Z!==void 0?Z:x.contentRect.height;if(q===Q)return;q-e.itemSize===0?b.delete(v):b.set(v,q-e.itemSize);const ue=q-Q;if(ue===0)return;Y.add(j,ue);const a=k.value;if(a!=null){if(F===void 0){const m=Y.sum(j);a.scrollTop>m&&a.scrollBy(0,ue)}else if(j<F)a.scrollBy(0,ue);else if(j===F){const m=Y.sum(j);q+m>a.scrollTop+a.offsetHeight&&a.scrollBy(0,ue)}le()}$.value++}const K=!no();let J=!1;function oe(v){var x;(x=e.onScroll)===null||x===void 0||x.call(e,v),(!K||!J)&&le()}function ve(v){var x;if((x=e.onWheel)===null||x===void 0||x.call(e,v),K){const N=k.value;if(N!=null){if(v.deltaX===0&&(N.scrollTop===0&&v.deltaY<=0||N.scrollTop+N.offsetHeight>=N.scrollHeight&&v.deltaY>=0))return;v.preventDefault(),N.scrollTop+=v.deltaY/It(),N.scrollLeft+=v.deltaX/It(),le(),J=!0,kn(()=>{J=!1})}}}function ge(v){if(o||X(v.target))return;if(e.renderCol==null&&e.renderItemWithCols==null){if(v.contentRect.height===f.value)return}else if(v.contentRect.height===f.value&&v.contentRect.width===r.value)return;f.value=v.contentRect.height,r.value=v.contentRect.width;const{onResize:x}=e;x!==void 0&&x(v)}function le(){const{value:v}=k;v!=null&&(T.value=v.scrollTop,u.value=v.scrollLeft)}function X(v){let x=v;for(;x!==null;){if(x.style.display==="none")return!0;x=x.parentElement}return!1}return{listHeight:f,listStyle:{overflow:"auto"},keyToIndex:d,itemsStyle:P(()=>{const{itemResizable:v}=e,x=qe(w.value.sum());return $.value,[e.itemsStyle,{boxSizing:"content-box",width:qe(i.value),height:v?"":x,minHeight:v?x:"",paddingTop:qe(e.paddingTop),paddingBottom:qe(e.paddingBottom)}]}),visibleItemsStyle:P(()=>($.value,{transform:`translateY(${qe(w.value.sum(g.value))})`})),viewportItems:p,listElRef:k,itemsElRef:I(null),scrollTo:O,handleListResize:ge,handleListScroll:oe,handleListWheel:ve,handleItemResize:H}},render(){const{itemResizable:e,keyField:t,keyToIndex:o,visibleItemsTag:l}=this;return Se(zt,{onResize:this.handleListResize},{default:()=>{var i,d;return Se("div",Ie(this.$attrs,{class:["v-vl",this.showScrollbar&&"v-vl--show-scrollbar"],onScroll:this.handleListScroll,onWheel:this.handleListWheel,ref:"listElRef"}),[this.items.length!==0?Se("div",{ref:"itemsElRef",class:"v-vl-items",style:this.itemsStyle},[Se(l,Object.assign({class:"v-vl-visible-items",style:this.visibleItemsStyle},this.visibleItemsProps),{default:()=>{const{renderCol:u,renderItemWithCols:r}=this;return this.viewportItems.map(k=>{const f=k[t],b=o.get(f),w=u!=null?Se(Pt,{index:b,item:k}):void 0,$=r!=null?Se(Pt,{index:b,item:k}):void 0,T=this.$slots.default({item:k,renderedCols:w,renderedItemWithCols:$,index:b})[0];return e?Se(zt,{key:f,onResize:g=>this.handleItemResize(f,g)},{default:()=>T}):(T.key=f,T)})}})]):(d=(i=this.$slots).empty)===null||d===void 0?void 0:d.call(i)])}})}}),Fe="v-hidden",io=rt("[v-hidden]",{display:"none!important"}),Bt=be({name:"Overflow",props:{getCounter:Function,getTail:Function,updateCounter:Function,onUpdateCount:Function,onUpdateOverflow:Function},setup(e,{slots:t}){const o=I(null),l=I(null);function i(u){const{value:r}=o,{getCounter:k,getTail:f}=e;let b;if(k!==void 0?b=k():b=l.value,!r||!b)return;b.hasAttribute(Fe)&&b.removeAttribute(Fe);const{children:w}=r;if(u.showAllItemsBeforeCalculate)for(const E of w)E.hasAttribute(Fe)&&E.removeAttribute(Fe);const $=r.offsetWidth,T=[],g=t.tail?f==null?void 0:f():null;let p=g?g.offsetWidth:0,O=!1;const F=r.children.length-(t.tail?1:0);for(let E=0;E<F-1;++E){if(E<0)continue;const U=w[E];if(O){U.hasAttribute(Fe)||U.setAttribute(Fe,"");continue}else U.hasAttribute(Fe)&&U.removeAttribute(Fe);const H=U.offsetWidth;if(p+=H,T[E]=H,p>$){const{updateCounter:K}=e;for(let J=E;J>=0;--J){const oe=F-1-J;K!==void 0?K(oe):b.textContent=`${oe}`;const ve=b.offsetWidth;if(p-=T[J],p+ve<=$||J===0){O=!0,E=J-1,g&&(E===-1?(g.style.maxWidth=`${$-ve}px`,g.style.boxSizing="border-box"):g.style.maxWidth="");const{onUpdateCount:ge}=e;ge&&ge(oe);break}}}}const{onUpdateOverflow:R}=e;O?R!==void 0&&R(!0):(R!==void 0&&R(!1),b.setAttribute(Fe,""))}const d=Dt();return io.mount({id:"vueuc/overflow",head:!0,anchorMetaName:Vt,ssr:d}),Ze(()=>i({showAllItemsBeforeCalculate:!1})),{selfRef:o,counterRef:l,sync:i}},render(){const{$slots:e}=this;return kt(()=>this.sync({showAllItemsBeforeCalculate:!1})),Se("div",{class:"v-overflow",ref:"selfRef"},[Sn(e,"default"),e.counter?e.counter():Se("span",{style:{display:"inline-block"},ref:"counterRef"}),e.tail?e.tail():null])}});var ao={color:Object,type:{type:String,default:"default"},round:Boolean,size:String,closable:Boolean,disabled:{type:Boolean,default:void 0}},so=W("tag",`
 --n-close-margin: var(--n-close-margin-top) var(--n-close-margin-right) var(--n-close-margin-bottom) var(--n-close-margin-left);
 white-space: nowrap;
 position: relative;
 box-sizing: border-box;
 cursor: default;
 display: inline-flex;
 align-items: center;
 flex-wrap: nowrap;
 padding: var(--n-padding);
 border-radius: var(--n-border-radius);
 color: var(--n-text-color);
 background-color: var(--n-color);
 transition: 
 border-color .3s var(--n-bezier),
 background-color .3s var(--n-bezier),
 color .3s var(--n-bezier),
 box-shadow .3s var(--n-bezier),
 opacity .3s var(--n-bezier);
 line-height: 1;
 height: var(--n-height);
 font-size: var(--n-font-size);
`,[ne("strong",`
 font-weight: var(--n-font-weight-strong);
 `),D("border",`
 pointer-events: none;
 position: absolute;
 left: 0;
 right: 0;
 top: 0;
 bottom: 0;
 border-radius: inherit;
 border: var(--n-border);
 transition: border-color .3s var(--n-bezier);
 `),D("icon",`
 display: flex;
 margin: 0 4px 0 0;
 color: var(--n-text-color);
 transition: color .3s var(--n-bezier);
 font-size: var(--n-avatar-size-override);
 `),D("avatar",`
 display: flex;
 margin: 0 6px 0 0;
 `),D("close",`
 margin: var(--n-close-margin);
 transition:
 background-color .3s var(--n-bezier),
 color .3s var(--n-bezier);
 `),ne("round",`
 padding: 0 calc(var(--n-height) / 3);
 border-radius: calc(var(--n-height) / 2);
 `,[D("icon",`
 margin: 0 4px 0 calc((var(--n-height) - 8px) / -2);
 `),D("avatar",`
 margin: 0 6px 0 calc((var(--n-height) - 8px) / -2);
 `),ne("closable",`
 padding: 0 calc(var(--n-height) / 4) 0 calc(var(--n-height) / 3);
 `)]),ne("icon, avatar",[ne("round",`
 padding: 0 calc(var(--n-height) / 3) 0 calc(var(--n-height) / 2);
 `)]),ne("disabled",`
 cursor: not-allowed !important;
 opacity: var(--n-opacity-disabled);
 `),ne("checkable",`
 cursor: pointer;
 box-shadow: none;
 color: var(--n-text-color-checkable);
 background-color: var(--n-color-checkable);
 `,[_e("disabled",[he("&:hover","background-color: var(--n-color-hover-checkable);",[_e("checked","color: var(--n-text-color-hover-checkable);")]),he("&:active","background-color: var(--n-color-pressed-checkable);",[_e("checked","color: var(--n-text-color-pressed-checkable);")])]),ne("checked",`
 color: var(--n-text-color-checked);
 background-color: var(--n-color-checked);
 `,[_e("disabled",[he("&:hover","background-color: var(--n-color-checked-hover);"),he("&:active","background-color: var(--n-color-checked-pressed);")])])])]);const co=["onClick","onMouseenter","onMouseleave"],uo={...Re.props,...ao,bordered:{type:Boolean,default:void 0},checked:Boolean,checkable:Boolean,strong:Boolean,triggerClickOnClose:Boolean,onClose:[Array,Function],onMouseenter:Function,onMouseleave:Function,"onUpdate:checked":Function,onUpdateChecked:Function,internalCloseFocusable:{type:Boolean,default:!0},internalCloseIsButtonTag:{type:Boolean,default:!0},onCheckedChange:Function},fo=Fn("n-tag");var bt=be({name:"Tag",props:uo,slots:Object,setup(e){const t=I(null),{mergedBorderedRef:o,mergedClsPrefixRef:l,inlineThemeDisabled:i,mergedRtlRef:d,mergedComponentPropsRef:u}=Xe(e),r=P(()=>{var p,O;return e.size||((O=(p=u==null?void 0:u.value)==null?void 0:p.Tag)==null?void 0:O.size)||"medium"}),k=Re("Tag","-tag",so,zn,e,l);it(fo,{roundRef:ie(e,"round")});function f(){if(!e.disabled&&e.checkable){const{checked:p,onCheckedChange:O,onUpdateChecked:F,"onUpdate:checked":R}=e;F&&F(!p),R&&R(!p),O&&O(!p)}}function b(p){if(e.triggerClickOnClose||p.stopPropagation(),!e.disabled){const{onClose:O}=e;O&&we(O,p)}}const w={setTextContent(p){const{value:O}=t;O&&(O.textContent=p)}},$=St("Tag",d,l),T=P(()=>{const{type:p,color:{color:O,textColor:F}={}}=e,R=r.value,{common:{cubicBezierEaseInOut:E},self:{padding:U,closeMargin:H,borderRadius:K,opacityDisabled:J,textColorCheckable:oe,textColorHoverCheckable:ve,textColorPressedCheckable:ge,textColorChecked:le,colorCheckable:X,colorHoverCheckable:v,colorPressedCheckable:x,colorChecked:N,colorCheckedHover:A,colorCheckedPressed:Z,closeBorderRadius:Y,fontWeightStrong:j,[ee("colorBordered",p)]:Q,[ee("closeSize",R)]:q,[ee("closeIconSize",R)]:se,[ee("fontSize",R)]:ue,[ee("height",R)]:a,[ee("color",p)]:m,[ee("textColor",p)]:te,[ee("border",p)]:pe,[ee("closeIconColor",p)]:ze,[ee("closeIconColorHover",p)]:me,[ee("closeIconColorPressed",p)]:fe,[ee("closeColorHover",p)]:Te,[ee("closeColorPressed",p)]:xe}}=k.value,Ce=Ve(H);return{"--n-font-weight-strong":j,"--n-avatar-size-override":`calc(${a} - 8px)`,"--n-bezier":E,"--n-border-radius":K,"--n-border":pe,"--n-close-icon-size":se,"--n-close-color-pressed":xe,"--n-close-color-hover":Te,"--n-close-border-radius":Y,"--n-close-icon-color":ze,"--n-close-icon-color-hover":me,"--n-close-icon-color-pressed":fe,"--n-close-icon-color-disabled":ze,"--n-close-margin-top":Ce.top,"--n-close-margin-right":Ce.right,"--n-close-margin-bottom":Ce.bottom,"--n-close-margin-left":Ce.left,"--n-close-size":q,"--n-color":O||(o.value?Q:m),"--n-color-checkable":X,"--n-color-checked":N,"--n-color-checked-hover":A,"--n-color-checked-pressed":Z,"--n-color-hover-checkable":v,"--n-color-pressed-checkable":x,"--n-font-size":ue,"--n-height":a,"--n-opacity-disabled":J,"--n-padding":U,"--n-text-color":F||te,"--n-text-color-checkable":oe,"--n-text-color-checked":le,"--n-text-color-hover-checkable":ve,"--n-text-color-pressed-checkable":ge}}),g=i?Ye("tag",P(()=>{let p="";const{type:O,color:{color:F,textColor:R}={}}=e;return p+=O[0],p+=r.value[0],F&&(p+=`a${Ft(F)}`),R&&(p+=`b${Ft(R)}`),o.value&&(p+="c"),p}),T,e):void 0;return{...w,rtlEnabled:$,mergedClsPrefix:l,contentRef:t,mergedBordered:o,handleClick:f,handleCloseClick:b,cssVars:i?void 0:T,themeClass:g==null?void 0:g.themeClass,onRender:g==null?void 0:g.onRender}},render(){const{mergedClsPrefix:e,rtlEnabled:t,closable:o,color:{borderColor:l}={},round:i,onRender:d,$slots:u}=this;d==null||d();const r=at(u.avatar,f=>f&&(c(),C("div",{class:M(`${e}-tag__avatar`)},[S(()=>f)],2))),k=at(u.icon,f=>f&&(c(),C("div",{class:M(`${e}-tag__icon`)},[S(()=>f)],2)));return c(),C("div",{class:M([`${e}-tag`,this.themeClass,{[`${e}-tag--rtl`]:t,[`${e}-tag--strong`]:this.strong,[`${e}-tag--disabled`]:this.disabled,[`${e}-tag--checkable`]:this.checkable,[`${e}-tag--checked`]:this.checkable&&this.checked,[`${e}-tag--round`]:i,[`${e}-tag--avatar`]:r,[`${e}-tag--icon`]:k,[`${e}-tag--closable`]:o}]),style:Ne(this.cssVars),onClick:this.handleClick,onMouseenter:this.onMouseenter,onMouseleave:this.onMouseleave},[S(()=>k||r),de("span",{class:M(`${e}-tag__content`),ref:"contentRef"},[S(()=>{var f,b;return(b=(f=this.$slots).default)==null?void 0:b.call(f)})],2),!this.checkable&&o?(c(),G(Rn,{key:0,clsPrefix:e,class:M(`${e}-tag__close`),disabled:this.disabled,onClick:this.handleCloseClick,focusable:this.internalCloseFocusable,round:i,isButtonTag:this.internalCloseIsButtonTag,absolute:!0},null,8,["clsPrefix","class","disabled","onClick","focusable","round","isButtonTag"])):S(()=>null),!this.checkable&&this.mergedBordered?(c(),C("div",{key:2,class:M(`${e}-tag__border`),style:Ne({borderColor:l})},null,6)):S(()=>null)],46,co)}});function _t(e){switch(typeof e){case"string":return e||void 0;case"number":return String(e);default:return}}function Ht(e,t){t&&(Ze(()=>{const{value:o}=e;o&&vt.registerHandler(o,t)}),Ee(e,(o,l)=>{l&&vt.unregisterHandler(l)},{deep:!1}),Nt(()=>{const{value:o}=e;o&&vt.unregisterHandler(o)}))}var ho=be({props:{onFocus:Function,onBlur:Function},setup(e){return()=>(()=>{const t=xt("d16ead82505dc285");return c(),C("div",{style:"width: 0; height: 0",tabindex:0,onFocus:t[0]||(t[0]=o=>{var l;return(l=e.onFocus)==null?void 0:l.call(e,o)}),onBlur:t[1]||(t[1]=o=>{var l;return(l=e.onBlur)==null?void 0:l.call(e,o)})},null,32)})()}}),vo=ho,$t=be({name:"NBaseSelectGroupHeader",props:{clsPrefix:{type:String,required:!0},tmNode:{type:Object,required:!0}},setup(){const{renderLabelRef:e,renderOptionRef:t,labelFieldRef:o,nodePropsRef:l}=Ct(Rt);return{labelField:o,nodeProps:l,renderLabel:e,renderOption:t}},render(){const{clsPrefix:e,renderLabel:t,renderOption:o,nodeProps:l,tmNode:{rawNode:i}}=this,d=l==null?void 0:l(i),u=t?t(i,!1):De(i[this.labelField],i,!1),r=(c(),C("div",Ie(d,{class:[`${e}-base-select-group-header`,d==null?void 0:d.class]}),[S(()=>u)],16));return i.render?i.render({node:r,option:i}):o?o({node:r,option:i,selected:!1}):r}});function pt(e){const t=e.filter(o=>o!==void 0);if(t.length!==0)return t.length===1?t[0]:o=>{e.forEach(l=>{l&&l(o)})}}var go=be({name:"Checkmark",render(){return(()=>{const e=xt("3c84eac8ae4e1f96");return e[0]||(e[0]=de("svg",{xmlns:"http://www.w3.org/2000/svg",viewBox:"0 0 16 16"},[de("g",{fill:"none"},[de("path",{d:"M14.046 3.486a.75.75 0 0 1-.032 1.06l-7.93 7.474a.85.85 0 0 1-1.188-.022l-2.68-2.72a.75.75 0 1 1 1.068-1.053l2.234 2.267l7.468-7.038a.75.75 0 0 1 1.06.032z",fill:"currentColor"})])],-1))})()}});const bo=["onClick","onMouseenter","onMousemove"];function po(e,t){return c(),G(Wt,{name:"fade-in-scale-up-transition"},{default:()=>e?(c(),G(At,{key:1,clsPrefix:t,class:M(`${t}-base-select-option__check`)},{default:()=>Se(go)},1032,["clsPrefix","class"])):null},1024)}var Et=be({name:"NBaseSelectOption",props:{clsPrefix:{type:String,required:!0},tmNode:{type:Object,required:!0}},setup(e){const{valueRef:t,pendingTmNodeRef:o,multipleRef:l,valueSetRef:i,renderLabelRef:d,renderOptionRef:u,labelFieldRef:r,valueFieldRef:k,showCheckmarkRef:f,nodePropsRef:b,handleOptionClick:w,handleOptionMouseEnter:$}=Ct(Rt),T=$e(()=>{const{value:F}=o;return F?e.tmNode.key===F.key:!1});function g(F){const{tmNode:R}=e;R.disabled||w(F,R)}function p(F){const{tmNode:R}=e;R.disabled||$(F,R)}function O(F){const{tmNode:R}=e,{value:E}=T;R.disabled||E||$(F,R)}return{multiple:l,isGrouped:$e(()=>{const{tmNode:F}=e,{parent:R}=F;return R&&R.rawNode.type==="group"}),showCheckmark:f,nodeProps:b,isPending:T,isSelected:$e(()=>{const{value:F}=t,{value:R}=l;if(F===null)return!1;const E=e.tmNode.rawNode[k.value];if(R){const{value:U}=i;return U.has(E)}else return F===E}),labelField:r,renderLabel:d,renderOption:u,handleMouseMove:O,handleMouseEnter:p,handleClick:g}},render(){const{clsPrefix:e,tmNode:{rawNode:t},isSelected:o,isPending:l,isGrouped:i,showCheckmark:d,nodeProps:u,renderOption:r,renderLabel:k,handleClick:f,handleMouseEnter:b,handleMouseMove:w}=this,$=po(o,e),T=k?[k(t,o),d&&$]:[De(t[this.labelField],t,o),d&&$],g=u==null?void 0:u(t),p=(c(),C("div",Ie(g,{class:[`${e}-base-select-option`,t.class,g==null?void 0:g.class,{[`${e}-base-select-option--disabled`]:t.disabled,[`${e}-base-select-option--selected`]:o,[`${e}-base-select-option--grouped`]:i,[`${e}-base-select-option--pending`]:l,[`${e}-base-select-option--show-checkmark`]:d}],style:[(g==null?void 0:g.style)||"",t.style||""],onClick:pt([f,g==null?void 0:g.onClick]),onMouseenter:pt([b,g==null?void 0:g.onMouseenter]),onMousemove:pt([w,g==null?void 0:g.onMousemove])}),[de("div",{class:M(`${e}-base-select-option__content`)},[S(()=>T)],2)],16,bo));return t.render?t.render({node:p,option:t,selected:o}):r?r({node:p,option:t,selected:o}):p}}),mo=W("base-select-menu",`
 line-height: 1.5;
 outline: none;
 z-index: 0;
 position: relative;
 border-radius: var(--n-border-radius);
 transition:
 background-color .3s var(--n-bezier),
 box-shadow .3s var(--n-bezier);
 background-color: var(--n-color);
`,[W("scrollbar",`
 max-height: var(--n-height);
 `),W("virtual-list",`
 max-height: var(--n-height);
 `),W("base-select-option",`
 min-height: var(--n-option-height);
 font-size: var(--n-option-font-size);
 display: flex;
 align-items: center;
 `,[D("content",`
 z-index: 1;
 white-space: nowrap;
 text-overflow: ellipsis;
 overflow: hidden;
 `)]),W("base-select-group-header",`
 min-height: var(--n-option-height);
 font-size: .93em;
 display: flex;
 align-items: center;
 `),W("base-select-menu-option-wrapper",`
 position: relative;
 width: 100%;
 `),D("loading, empty",`
 display: flex;
 padding: 12px 32px;
 flex: 1;
 justify-content: center;
 `),D("loading",`
 color: var(--n-loading-color);
 font-size: var(--n-loading-size);
 `),D("header",`
 padding: 8px var(--n-option-padding-left);
 font-size: var(--n-option-font-size);
 transition: 
 color .3s var(--n-bezier),
 border-color .3s var(--n-bezier);
 border-bottom: 1px solid var(--n-action-divider-color);
 color: var(--n-action-text-color);
 `),D("action",`
 padding: 8px var(--n-option-padding-left);
 font-size: var(--n-option-font-size);
 transition: 
 color .3s var(--n-bezier),
 border-color .3s var(--n-bezier);
 border-top: 1px solid var(--n-action-divider-color);
 color: var(--n-action-text-color);
 `),W("base-select-group-header",`
 position: relative;
 cursor: default;
 padding: var(--n-option-padding);
 color: var(--n-group-header-text-color);
 `),W("base-select-option",`
 cursor: pointer;
 position: relative;
 padding: var(--n-option-padding);
 transition:
 color .3s var(--n-bezier),
 opacity .3s var(--n-bezier);
 box-sizing: border-box;
 color: var(--n-option-text-color);
 opacity: 1;
 `,[ne("show-checkmark",`
 padding-right: calc(var(--n-option-padding-right) + 20px);
 `),he("&::before",`
 content: "";
 position: absolute;
 left: 4px;
 right: 4px;
 top: 0;
 bottom: 0;
 border-radius: var(--n-border-radius);
 transition: background-color .3s var(--n-bezier);
 `),he("&:active",`
 color: var(--n-option-text-color-pressed);
 `),ne("grouped",`
 padding-left: calc(var(--n-option-padding-left) * 1.5);
 `),ne("pending",[he("&::before",`
 background-color: var(--n-option-color-pending);
 `)]),ne("selected",`
 color: var(--n-option-text-color-active);
 `,[he("&::before",`
 background-color: var(--n-option-color-active);
 `),ne("pending",[he("&::before",`
 background-color: var(--n-option-color-active-pending);
 `)])]),ne("disabled",`
 cursor: not-allowed;
 `,[_e("selected",`
 color: var(--n-option-text-color-disabled);
 `),ne("selected",`
 opacity: var(--n-option-opacity-disabled);
 `)]),D("check",`
 font-size: 16px;
 position: absolute;
 right: calc(var(--n-option-padding-right) - 4px);
 top: calc(50% - 7px);
 color: var(--n-option-check-color);
 transition: color .3s var(--n-bezier);
 `,[Kt({enterScale:"0.5"})])])]);const yo=["tabindex","onFocusin","onFocusout","onKeyup","onKeydown","onMousedown","onMouseenter","onMouseleave"];var wo=be({name:"InternalSelectMenu",props:{...Re.props,clsPrefix:{type:String,required:!0},scrollable:{type:Boolean,default:!0},treeMate:{type:Object,required:!0},multiple:Boolean,size:{type:String,default:"medium"},value:{type:[String,Number,Array],default:null},autoPending:Boolean,virtualScroll:{type:Boolean,default:!0},show:{type:Boolean,default:!0},labelField:{type:String,default:"label"},valueField:{type:String,default:"value"},loading:Boolean,focusable:Boolean,renderLabel:Function,renderOption:Function,nodeProps:Function,showCheckmark:{type:Boolean,default:!0},onMousedown:Function,onScroll:Function,onFocus:Function,onBlur:Function,onKeyup:Function,onKeydown:Function,onTabOut:Function,onMouseenter:Function,onMouseleave:Function,onResize:Function,resetMenuOnOptionsChange:{type:Boolean,default:!0},inlineThemeDisabled:Boolean,scrollbarProps:Object,onToggle:Function},setup(e){const{mergedClsPrefixRef:t,mergedRtlRef:o,mergedComponentPropsRef:l}=Xe(e),i=St("InternalSelectMenu",o,t),d=Re("InternalSelectMenu","-internal-select-menu",mo,On,e,ie(e,"clsPrefix")),u=I(null),r=I(null),k=I(null),f=P(()=>e.treeMate.getFlattenedNodes()),b=P(()=>Pn(f.value)),w=I(null);function $(){const{treeMate:a}=e;let m=null;const{value:te}=e;te===null?m=a.getFirstAvailableNode():(e.multiple?m=a.getNode((te||[])[(te||[]).length-1]):m=a.getNode(te),(!m||m.disabled)&&(m=a.getFirstAvailableNode())),A(m||null)}function T(){const{value:a}=w;a&&!e.treeMate.getNode(a.key)&&(w.value=null)}let g;Ee(()=>e.show,a=>{a?g=Ee(()=>e.treeMate,()=>{e.resetMenuOnOptionsChange?(e.autoPending?$():T(),kt(Z)):T()},{immediate:!0}):g==null||g()},{immediate:!0}),Nt(()=>{g==null||g()});const p=P(()=>yt(d.value.self[ee("optionHeight",e.size)])),O=P(()=>Ve(d.value.self[ee("padding",e.size)])),F=P(()=>e.multiple&&Array.isArray(e.value)?new Set(e.value):new Set),R=P(()=>{const a=f.value;return a&&a.length===0}),E=P(()=>{var a,m;return(m=(a=l==null?void 0:l.value)==null?void 0:a.Select)==null?void 0:m.renderEmpty});function U(a){const{onToggle:m}=e;m&&m(a)}function H(a){const{onScroll:m}=e;m&&m(a)}function K(a){var m;(m=k.value)==null||m.sync(),H(a)}function J(){var a;(a=k.value)==null||a.sync()}function oe(){const{value:a}=w;return a||null}function ve(a,m){m.disabled||A(m,!1)}function ge(a,m){m.disabled||U(m)}function le(a){var m;Ge(a,"action")||(m=e.onKeyup)==null||m.call(e,a)}function X(a){var m;Ge(a,"action")||(m=e.onKeydown)==null||m.call(e,a)}function v(a){var m;(m=e.onMousedown)==null||m.call(e,a),!e.focusable&&a.preventDefault()}function x(){const{value:a}=w;a&&A(a.getNext({loop:!0}),!0)}function N(){const{value:a}=w;a&&A(a.getPrev({loop:!0}),!0)}function A(a,m=!1){w.value=a,m&&Z()}function Z(){var te,pe;const a=w.value;if(!a)return;const m=b.value(a.key);m!==null&&(e.virtualScroll?(te=r.value)==null||te.scrollTo({index:m}):(pe=k.value)==null||pe.scrollTo({index:m,elSize:p.value}))}function Y(a){var m,te;(m=u.value)!=null&&m.contains(a.target)&&((te=e.onFocus)==null||te.call(e,a))}function j(a){var m,te;(m=u.value)!=null&&m.contains(a.relatedTarget)||(te=e.onBlur)==null||te.call(e,a)}it(Rt,{handleOptionMouseEnter:ve,handleOptionClick:ge,valueSetRef:F,pendingTmNodeRef:w,nodePropsRef:ie(e,"nodeProps"),showCheckmarkRef:ie(e,"showCheckmark"),multipleRef:ie(e,"multiple"),valueRef:ie(e,"value"),renderLabelRef:ie(e,"renderLabel"),renderOptionRef:ie(e,"renderOption"),labelFieldRef:ie(e,"labelField"),valueFieldRef:ie(e,"valueField")}),it(Bn,u),Ze(()=>{const{value:a}=k;a&&a.sync()});const Q=P(()=>{const{size:a}=e,{common:{cubicBezierEaseInOut:m},self:{height:te,borderRadius:pe,color:ze,groupHeaderTextColor:me,actionDividerColor:fe,optionTextColorPressed:Te,optionTextColor:xe,optionTextColorDisabled:Ce,optionTextColorActive:We,optionOpacityDisabled:Ke,optionCheckColor:Pe,actionTextColor:Be,optionColorPending:je,optionColorActive:Ue,loadingColor:He,loadingSize:Ae,optionColorActivePending:Le,[ee("optionFontSize",a)]:ye,[ee("optionHeight",a)]:s,[ee("optionPadding",a)]:y}}=d.value;return{"--n-height":te,"--n-action-divider-color":fe,"--n-action-text-color":Be,"--n-bezier":m,"--n-border-radius":pe,"--n-color":ze,"--n-option-font-size":ye,"--n-group-header-text-color":me,"--n-option-check-color":Pe,"--n-option-color-pending":je,"--n-option-color-active":Ue,"--n-option-color-active-pending":Le,"--n-option-height":s,"--n-option-opacity-disabled":Ke,"--n-option-text-color":xe,"--n-option-text-color-active":We,"--n-option-text-color-disabled":Ce,"--n-option-text-color-pressed":Te,"--n-option-padding":y,"--n-option-padding-left":Ve(y,"left"),"--n-option-padding-right":Ve(y,"right"),"--n-loading-color":He,"--n-loading-size":Ae}}),{inlineThemeDisabled:q}=e,se=q?Ye("internal-select-menu",P(()=>e.size[0]),Q,e):void 0,ue={selfRef:u,next:x,prev:N,getPendingTmNode:oe};return Ht(u,e.onResize),{mergedTheme:d,mergedClsPrefix:t,rtlEnabled:i,virtualListRef:r,scrollbarRef:k,itemSize:p,padding:O,flattenedNodes:f,empty:R,mergedRenderEmpty:E,virtualListContainer(){const{value:a}=r;return a==null?void 0:a.listElRef},virtualListContent(){const{value:a}=r;return a==null?void 0:a.itemsElRef},doScroll:H,handleFocusin:Y,handleFocusout:j,handleKeyUp:le,handleKeyDown:X,handleMouseDown:v,handleVirtualListResize:J,handleVirtualListScroll:K,cssVars:q?void 0:Q,themeClass:se==null?void 0:se.themeClass,onRender:se==null?void 0:se.onRender,...ue}},render(){const{$slots:e,virtualScroll:t,clsPrefix:o,mergedTheme:l,themeClass:i,onRender:d}=this;return d==null||d(),c(),C("div",{ref:"selfRef",tabindex:this.focusable?0:-1,class:M([`${o}-base-select-menu`,`${o}-base-select-menu--${this.size}-size`,this.rtlEnabled&&`${o}-base-select-menu--rtl`,i,this.multiple&&`${o}-base-select-menu--multiple`]),style:Ne(this.cssVars),onFocusin:this.handleFocusin,onFocusout:this.handleFocusout,onKeyup:this.handleKeyUp,onKeydown:this.handleKeyDown,onMousedown:this.handleMouseDown,onMouseenter:this.onMouseenter,onMouseleave:this.onMouseleave},[S(()=>at(e.header,u=>u&&(c(),C("div",{class:M(`${o}-base-select-menu__header`),"data-header":!0,key:"header"},[S(()=>u)],2)))),this.loading?(c(),C("div",{key:0,class:M(`${o}-base-select-menu__loading`)},[(c(),G(In,{clsPrefix:o,strokeWidth:20},null,8,["clsPrefix"]))],2)):(c(),C(ae,{key:1},[this.empty?(c(),C("div",{key:1,class:M(`${o}-base-select-menu__empty`),"data-empty":!0},[S(()=>Mn(e.empty,()=>{var u;return[((u=this.mergedRenderEmpty)==null?void 0:u.call(this))||(c(),G(to,{theme:l.peers.Empty,themeOverrides:l.peerOverrides.Empty,size:this.size},null,8,["theme","themeOverrides","size"]))]}))],2)):(c(),G(Tn,Ie({key:0,ref:"scrollbarRef",theme:l.peers.Scrollbar,themeOverrides:l.peerOverrides.Scrollbar,scrollable:this.scrollable,container:t?this.virtualListContainer:void 0,content:t?this.virtualListContent:void 0,onScroll:t?void 0:this.doScroll},this.scrollbarProps),{default:()=>t?(c(),G(ro,{key:1,ref:"virtualListRef",class:M(`${o}-virtual-list`),items:this.flattenedNodes,itemSize:this.itemSize,showScrollbar:!1,paddingTop:this.padding.top,paddingBottom:this.padding.bottom,onResize:this.handleVirtualListResize,onScroll:this.handleVirtualListScroll,itemResizable:!0},{default:({item:u})=>u.isGroup?(c(),G($t,{key:u.key,clsPrefix:o,tmNode:u},null,8,["clsPrefix","tmNode"])):u.ignored?null:(c(),G(Et,{clsPrefix:o,key:u.key,tmNode:u},null,8,["clsPrefix","tmNode"]))},1032,["class","items","itemSize","paddingTop","paddingBottom","onResize","onScroll"])):(c(),C("div",{key:4,class:M(`${o}-base-select-menu-option-wrapper`),style:Ne({paddingTop:this.padding.top,paddingBottom:this.padding.bottom})},[S(()=>this.flattenedNodes.map(u=>u.isGroup?(c(),G($t,{key:u.key,clsPrefix:o,tmNode:u},null,8,["clsPrefix","tmNode"])):(c(),G(Et,{clsPrefix:o,key:u.key,tmNode:u},null,8,["clsPrefix","tmNode"]))))],6))},1040,["theme","themeOverrides","scrollable","container","content","onScroll"]))],64)),S(()=>at(e.action,u=>u&&[(c(),C("div",{class:M(`${o}-base-select-menu__action`),"data-action":!0,key:"action"},[S(()=>u)],2)),(c(),G(vo,{onFocus:this.onTabOut,key:"focus-detector"},null,8,["onFocus"]))]))],46,yo)}});function st(e){return e.type==="group"}function qt(e){return e.type==="ignored"}function mt(e,t){try{return!!(1+t.toString().toLowerCase().indexOf(e.trim().toLowerCase()))}catch{return!1}}function xo(e,t){return{getIsGroup:st,getIgnored:qt,getKey(o){return st(o)?o.name||o.key||"key-required":o[e]},getChildren(o){return o[t]}}}function Co(e,t,o,l){if(!t)return e;function i(d){if(!Array.isArray(d))return[];const u=[];for(const r of d)if(st(r)){const k=i(r[l]);k.length&&u.push(Object.assign({},r,{[l]:k}))}else{if(qt(r))continue;t(o,r)&&u.push(r)}return u}return i(e)}function ko(e,t,o){const l=new Map;return e.forEach(i=>{st(i)?i[o].forEach(d=>{l.set(d[t],d)}):l.set(i[t],i)}),l}var So=he([W("base-selection",`
 --n-padding-single: var(--n-padding-single-top) var(--n-padding-single-right) var(--n-padding-single-bottom) var(--n-padding-single-left);
 --n-padding-multiple: var(--n-padding-multiple-top) var(--n-padding-multiple-right) var(--n-padding-multiple-bottom) var(--n-padding-multiple-left);
 position: relative;
 z-index: auto;
 box-shadow: none;
 width: 100%;
 max-width: 100%;
 display: inline-block;
 vertical-align: bottom;
 border-radius: var(--n-border-radius);
 min-height: var(--n-height);
 line-height: 1.5;
 font-size: var(--n-font-size);
 `,[W("base-loading",`
 color: var(--n-loading-color);
 `),W("base-selection-tags","min-height: var(--n-height);"),D("border, state-border",`
 position: absolute;
 left: 0;
 right: 0;
 top: 0;
 bottom: 0;
 pointer-events: none;
 border: var(--n-border);
 border-radius: inherit;
 transition:
 box-shadow .3s var(--n-bezier),
 border-color .3s var(--n-bezier);
 `),D("state-border",`
 z-index: 1;
 border-color: #0000;
 `),W("base-suffix",`
 cursor: pointer;
 position: absolute;
 top: 50%;
 transform: translateY(-50%);
 right: 10px;
 `,[D("arrow",`
 font-size: var(--n-arrow-size);
 color: var(--n-arrow-color);
 transition: color .3s var(--n-bezier);
 `)]),W("base-selection-overlay",`
 display: flex;
 align-items: center;
 white-space: nowrap;
 pointer-events: none;
 position: absolute;
 top: 0;
 right: 0;
 bottom: 0;
 left: 0;
 padding: var(--n-padding-single);
 transition: color .3s var(--n-bezier);
 `,[D("wrapper",`
 flex-basis: 0;
 flex-grow: 1;
 overflow: hidden;
 text-overflow: ellipsis;
 `)]),W("base-selection-placeholder",`
 color: var(--n-placeholder-color);
 `,[D("inner",`
 max-width: 100%;
 overflow: hidden;
 `)]),W("base-selection-tags",`
 cursor: pointer;
 outline: none;
 box-sizing: border-box;
 position: relative;
 z-index: auto;
 display: flex;
 padding: var(--n-padding-multiple);
 flex-wrap: wrap;
 align-items: center;
 width: 100%;
 vertical-align: bottom;
 background-color: var(--n-color);
 border-radius: inherit;
 transition:
 color .3s var(--n-bezier),
 box-shadow .3s var(--n-bezier),
 background-color .3s var(--n-bezier);
 `),W("base-selection-label",`
 height: var(--n-height);
 display: inline-flex;
 width: 100%;
 vertical-align: bottom;
 cursor: pointer;
 outline: none;
 z-index: auto;
 box-sizing: border-box;
 position: relative;
 transition:
 color .3s var(--n-bezier),
 box-shadow .3s var(--n-bezier),
 background-color .3s var(--n-bezier);
 border-radius: inherit;
 background-color: var(--n-color);
 align-items: center;
 `,[W("base-selection-input",`
 font-size: inherit;
 line-height: inherit;
 outline: none;
 cursor: pointer;
 box-sizing: border-box;
 border:none;
 width: 100%;
 padding: var(--n-padding-single);
 background-color: #0000;
 color: var(--n-text-color);
 transition: color .3s var(--n-bezier);
 caret-color: var(--n-caret-color);
 `,[D("content",`
 text-overflow: ellipsis;
 overflow: hidden;
 white-space: nowrap; 
 `)]),D("render-label",`
 color: var(--n-text-color);
 `)]),_e("disabled",[he("&:hover",[D("state-border",`
 box-shadow: var(--n-box-shadow-hover);
 border: var(--n-border-hover);
 `)]),ne("focus",[D("state-border",`
 box-shadow: var(--n-box-shadow-focus);
 border: var(--n-border-focus);
 `)]),ne("active",[D("state-border",`
 box-shadow: var(--n-box-shadow-active);
 border: var(--n-border-active);
 `),W("base-selection-label","background-color: var(--n-color-active);"),W("base-selection-tags","background-color: var(--n-color-active);")])]),ne("disabled","cursor: not-allowed;",[D("arrow",`
 color: var(--n-arrow-color-disabled);
 `),W("base-selection-label",`
 cursor: not-allowed;
 background-color: var(--n-color-disabled);
 `,[W("base-selection-input",`
 cursor: not-allowed;
 color: var(--n-text-color-disabled);
 `),D("render-label",`
 color: var(--n-text-color-disabled);
 `)]),W("base-selection-tags",`
 cursor: not-allowed;
 background-color: var(--n-color-disabled);
 `),W("base-selection-placeholder",`
 cursor: not-allowed;
 color: var(--n-placeholder-color-disabled);
 `)]),W("base-selection-input-tag",`
 height: calc(var(--n-height) - 6px);
 line-height: calc(var(--n-height) - 6px);
 outline: none;
 display: none;
 position: relative;
 margin-bottom: 3px;
 max-width: 100%;
 vertical-align: bottom;
 `,[D("input",`
 font-size: inherit;
 font-family: inherit;
 min-width: 1px;
 padding: 0;
 background-color: #0000;
 outline: none;
 border: none;
 max-width: 100%;
 overflow: hidden;
 width: 1em;
 line-height: inherit;
 cursor: pointer;
 color: var(--n-text-color);
 caret-color: var(--n-caret-color);
 `),D("mirror",`
 position: absolute;
 left: 0;
 top: 0;
 white-space: pre;
 visibility: hidden;
 user-select: none;
 -webkit-user-select: none;
 opacity: 0;
 `)]),["warning","error"].map(e=>ne(`${e}-status`,[D("state-border",`border: var(--n-border-${e});`),_e("disabled",[he("&:hover",[D("state-border",`
 box-shadow: var(--n-box-shadow-hover-${e});
 border: var(--n-border-hover-${e});
 `)]),ne("active",[D("state-border",`
 box-shadow: var(--n-box-shadow-active-${e});
 border: var(--n-border-active-${e});
 `),W("base-selection-label",`background-color: var(--n-color-active-${e});`),W("base-selection-tags",`background-color: var(--n-color-active-${e});`)]),ne("focus",[D("state-border",`
 box-shadow: var(--n-box-shadow-focus-${e});
 border: var(--n-border-focus-${e});
 `)])])]))]),W("base-selection-popover",`
 margin-bottom: -3px;
 display: flex;
 flex-wrap: wrap;
 margin-right: -8px;
 `),W("base-selection-tag-wrapper",`
 max-width: 100%;
 display: inline-flex;
 padding: 0 7px 3px 0;
 `,[he("&:last-child","padding-right: 0;"),W("tag",`
 font-size: 14px;
 max-width: 100%;
 `,[D("content",`
 line-height: 1.25;
 text-overflow: ellipsis;
 overflow: hidden;
 `)])])]);const Ro=["disabled","value","autofocus","onBlur","onFocus","onKeydown","onInput","onCompositionstart","onCompositionend"],zo=["tabindex"],Fo=["title"],To=["value","readonly","disabled","autofocus","onFocus","onBlur","onInput","onCompositionstart","onCompositionend"],Mo=["tabindex"],Oo=["onClick","onMouseenter","onMouseleave","onKeydown","onFocusin","onFocusout","onMousedown"];var Io=be({name:"InternalSelection",props:{...Re.props,clsPrefix:{type:String,required:!0},bordered:{type:Boolean,default:void 0},active:Boolean,pattern:{type:String,default:""},placeholder:String,selectedOption:{type:Object,default:null},selectedOptions:{type:Array,default:null},labelField:{type:String,default:"label"},valueField:{type:String,default:"value"},multiple:Boolean,filterable:Boolean,clearable:Boolean,disabled:Boolean,size:{type:String,default:"medium"},loading:Boolean,autofocus:Boolean,showArrow:{type:Boolean,default:!0},inputProps:Object,focused:Boolean,renderTag:Function,onKeydown:Function,onClick:Function,onBlur:Function,onFocus:Function,onDeleteOption:Function,maxTagCount:[String,Number],ellipsisTagPopoverProps:Object,onClear:Function,onPatternInput:Function,onPatternFocus:Function,onPatternBlur:Function,renderLabel:Function,status:String,inlineThemeDisabled:Boolean,ignoreComposition:{type:Boolean,default:!0},onResize:Function},setup(e){const{mergedClsPrefixRef:t,mergedRtlRef:o}=Xe(e),l=St("InternalSelection",o,t),i=I(null),d=I(null),u=I(null),r=I(null),k=I(null),f=I(null),b=I(null),w=I(null),$=I(null),T=I(null),g=I(!1),p=I(!1),O=I(!1),F=Re("InternalSelection","-internal-selection",So,An,e,ie(e,"clsPrefix")),R=P(()=>e.clearable&&!e.disabled&&(O.value||e.active)),E=P(()=>e.selectedOption?e.renderTag?e.renderTag({option:e.selectedOption,handleClose:()=>{}}):e.renderLabel?e.renderLabel(e.selectedOption,!0):De(e.selectedOption[e.labelField],e.selectedOption,!0):e.placeholder),U=P(()=>{const s=e.selectedOption;if(s)return s[e.labelField]}),H=P(()=>e.multiple?!!(Array.isArray(e.selectedOptions)&&e.selectedOptions.length):e.selectedOption!==null);function K(){var y;const{value:s}=i;if(s){const{value:ce}=d;ce&&(ce.style.width=`${s.offsetWidth}px`,e.maxTagCount!=="responsive"&&((y=$.value)==null||y.sync({showAllItemsBeforeCalculate:!1})))}}function J(){const{value:s}=T;s&&(s.style.display="none")}function oe(){const{value:s}=T;s&&(s.style.display="inline-block")}Ee(ie(e,"active"),s=>{s||J()}),Ee(ie(e,"pattern"),()=>{e.multiple&&kt(K)});function ve(s){const{onFocus:y}=e;y&&y(s)}function ge(s){const{onBlur:y}=e;y&&y(s)}function le(s){const{onDeleteOption:y}=e;y&&y(s)}function X(s){const{onClear:y}=e;y&&y(s)}function v(s){const{onPatternInput:y}=e;y&&y(s)}function x(s){var y;(!s.relatedTarget||!((y=u.value)!=null&&y.contains(s.relatedTarget)))&&ve(s)}function N(s){var y;(y=u.value)!=null&&y.contains(s.relatedTarget)||ge(s)}function A(s){X(s)}function Z(){O.value=!0}function Y(){O.value=!1}function j(s){!e.active||!e.filterable||s.target!==d.value&&s.preventDefault()}function Q(s){le(s)}const q=I(!1);function se(s){if(s.key==="Backspace"&&!q.value&&!e.pattern.length){const{selectedOptions:y}=e;y!=null&&y.length&&Q(y[y.length-1])}}let ue=null;function a(s){const{value:y}=i;y&&(y.textContent=s.target.value,K()),e.ignoreComposition&&q.value?ue=s:v(s)}function m(){q.value=!0}function te(){q.value=!1,e.ignoreComposition&&v(ue),ue=null}function pe(s){var y;p.value=!0,(y=e.onPatternFocus)==null||y.call(e,s)}function ze(s){var y;p.value=!1,(y=e.onPatternBlur)==null||y.call(e,s)}function me(){var s,y;if(e.filterable)p.value=!1,(s=f.value)==null||s.blur(),(y=d.value)==null||y.blur();else if(e.multiple){const{value:ce}=r;ce==null||ce.blur()}else{const{value:ce}=k;ce==null||ce.blur()}}function fe(){var s,y,ce;e.filterable?(p.value=!1,(s=f.value)==null||s.focus()):e.multiple?(y=r.value)==null||y.focus():(ce=k.value)==null||ce.focus()}function Te(){const{value:s}=d;s&&(oe(),s.focus())}function xe(){const{value:s}=d;s&&s.blur()}function Ce(s){const{value:y}=b;y&&y.setTextContent(`+${s}`)}function We(){const{value:s}=w;return s}function Ke(){return d.value}let Pe=null;function Be(){Pe!==null&&window.clearTimeout(Pe)}function je(){e.active||(Be(),Pe=window.setTimeout(()=>{H.value&&(g.value=!0)},100))}function Ue(){Be()}function He(s){s||(Be(),g.value=!1)}Ee(H,s=>{s||(g.value=!1)}),Ze(()=>{Ln(()=>{const s=f.value;s&&(e.disabled?s.removeAttribute("tabindex"):s.tabIndex=p.value?-1:0)})}),Ht(u,e.onResize);const{inlineThemeDisabled:Ae}=e,Le=P(()=>{const{size:s}=e,{common:{cubicBezierEaseInOut:y},self:{fontWeight:ce,borderRadius:ct,color:dt,placeholderColor:ut,textColor:Qe,paddingSingle:Je,paddingMultiple:et,caretColor:ft,colorDisabled:ht,textColorDisabled:tt,placeholderColorDisabled:Me,colorActive:n,boxShadowFocus:h,boxShadowActive:z,boxShadowHover:L,border:B,borderFocus:_,borderHover:V,borderActive:re,arrowColor:ke,arrowColorDisabled:Gt,loadingColor:Xt,colorActiveWarning:Yt,boxShadowFocusWarning:Zt,boxShadowActiveWarning:Qt,boxShadowHoverWarning:Jt,borderWarning:en,borderFocusWarning:tn,borderHoverWarning:nn,borderActiveWarning:on,colorActiveError:ln,boxShadowFocusError:rn,boxShadowActiveError:an,boxShadowHoverError:sn,borderError:cn,borderFocusError:dn,borderHoverError:un,borderActiveError:fn,clearColor:hn,clearColorHover:vn,clearColorPressed:gn,clearSize:bn,arrowSize:pn,[ee("height",s)]:mn,[ee("fontSize",s)]:yn}}=F.value,nt=Ve(Je),ot=Ve(et);return{"--n-bezier":y,"--n-border":B,"--n-border-active":re,"--n-border-focus":_,"--n-border-hover":V,"--n-border-radius":ct,"--n-box-shadow-active":z,"--n-box-shadow-focus":h,"--n-box-shadow-hover":L,"--n-caret-color":ft,"--n-color":dt,"--n-color-active":n,"--n-color-disabled":ht,"--n-font-size":yn,"--n-height":mn,"--n-padding-single-top":nt.top,"--n-padding-multiple-top":ot.top,"--n-padding-single-right":nt.right,"--n-padding-multiple-right":ot.right,"--n-padding-single-left":nt.left,"--n-padding-multiple-left":ot.left,"--n-padding-single-bottom":nt.bottom,"--n-padding-multiple-bottom":ot.bottom,"--n-placeholder-color":ut,"--n-placeholder-color-disabled":Me,"--n-text-color":Qe,"--n-text-color-disabled":tt,"--n-arrow-color":ke,"--n-arrow-color-disabled":Gt,"--n-loading-color":Xt,"--n-color-active-warning":Yt,"--n-box-shadow-focus-warning":Zt,"--n-box-shadow-active-warning":Qt,"--n-box-shadow-hover-warning":Jt,"--n-border-warning":en,"--n-border-focus-warning":tn,"--n-border-hover-warning":nn,"--n-border-active-warning":on,"--n-color-active-error":ln,"--n-box-shadow-focus-error":rn,"--n-box-shadow-active-error":an,"--n-box-shadow-hover-error":sn,"--n-border-error":cn,"--n-border-focus-error":dn,"--n-border-hover-error":un,"--n-border-active-error":fn,"--n-clear-size":bn,"--n-clear-color":hn,"--n-clear-color-hover":vn,"--n-clear-color-pressed":gn,"--n-arrow-size":pn,"--n-font-weight":ce}}),ye=Ae?Ye("internal-selection",P(()=>e.size[0]),Le,e):void 0;return{mergedTheme:F,mergedClearable:R,mergedClsPrefix:t,rtlEnabled:l,patternInputFocused:p,filterablePlaceholder:E,label:U,selected:H,showTagsPanel:g,isComposing:q,counterRef:b,counterWrapperRef:w,patternInputMirrorRef:i,patternInputRef:d,selfRef:u,multipleElRef:r,singleElRef:k,patternInputWrapperRef:f,overflowRef:$,inputTagElRef:T,handleMouseDown:j,handleFocusin:x,handleClear:A,handleMouseEnter:Z,handleMouseLeave:Y,handleDeleteOption:Q,handlePatternKeyDown:se,handlePatternInputInput:a,handlePatternInputBlur:ze,handlePatternInputFocus:pe,handleMouseEnterCounter:je,handleMouseLeaveCounter:Ue,handleFocusout:N,handleCompositionEnd:te,handleCompositionStart:m,onPopoverUpdateShow:He,focus:fe,focusInput:Te,blur:me,blurInput:xe,updateCounter:Ce,getCounter:We,getTail:Ke,renderLabel:e.renderLabel,cssVars:Ae?void 0:Le,themeClass:ye==null?void 0:ye.themeClass,onRender:ye==null?void 0:ye.onRender}},render(){const{status:e,multiple:t,size:o,disabled:l,filterable:i,maxTagCount:d,bordered:u,clsPrefix:r,ellipsisTagPopoverProps:k,onRender:f,renderTag:b,renderLabel:w}=this;f==null||f();const $=d==="responsive",T=typeof d=="number",g=$||T,p=(c(),G($n,null,{default:()=>(c(),G(_n,{clsPrefix:r,loading:this.loading,showArrow:this.showArrow,showClear:this.mergedClearable&&this.selected,onClear:this.handleClear},{default:()=>{var F,R;return(R=(F=this.$slots).arrow)==null?void 0:R.call(F)}},1032,["clsPrefix","loading","showArrow","showClear","onClear"]))},1024));let O;if(t){const{labelField:F}=this,R=X=>(c(),C("div",{class:M(`${r}-base-selection-tag-wrapper`),key:X.value},[b?(c(),C(ae,{key:0},[S(()=>b({option:X,handleClose:()=>{this.handleDeleteOption(X)}}))],64)):(c(),G(bt,{key:1,size:o,closable:!X.disabled,disabled:l,onClose:()=>{this.handleDeleteOption(X)},internalCloseIsButtonTag:!1,internalCloseFocusable:!1},{default:()=>w?w(X,!0):De(X[F],X,!0)},1032,["size","closable","disabled","onClose"]))],2)),E=()=>(T?this.selectedOptions.slice(0,d):this.selectedOptions).map(R),U=i?(c(),C("div",{class:M(`${r}-base-selection-input-tag`),ref:"inputTagElRef",key:"__input-tag__"},[de("input",Ie(this.inputProps,{ref:"patternInputRef",tabindex:-1,disabled:l,value:this.pattern,autofocus:this.autofocus,class:`${r}-base-selection-input-tag__input`,onBlur:this.handlePatternInputBlur,onFocus:this.handlePatternInputFocus,onKeydown:this.handlePatternKeyDown,onInput:this.handlePatternInputInput,onCompositionstart:this.handleCompositionStart,onCompositionend:this.handleCompositionEnd}),null,16,Ro),de("span",{ref:"patternInputMirrorRef",class:M(`${r}-base-selection-input-tag__mirror`)},[S(()=>this.pattern)],2)],2)):null,H=$?()=>(c(),C("div",{class:M(`${r}-base-selection-tag-wrapper`),ref:"counterWrapperRef"},[(c(),G(bt,{size:o,ref:"counterRef",onMouseenter:this.handleMouseEnterCounter,onMouseleave:this.handleMouseLeaveCounter,disabled:l},null,8,["size","onMouseenter","onMouseleave","disabled"]))],2)):void 0;let K;if(T){const X=this.selectedOptions.length-d;X>0&&(K=(v=>(c(),C("div",{class:M(`${r}-base-selection-tag-wrapper`),key:"__counter__"},[(c(),G(bt,{size:o,ref:"counterRef",onMouseenter:this.handleMouseEnterCounter,disabled:l},{default:()=>`+${X}`},1032,["size","onMouseenter","disabled"]))],2)))())}const J=$?i?(c(),G(Bt,{key:3,ref:"overflowRef",updateCounter:this.updateCounter,getCounter:this.getCounter,getTail:this.getTail,style:{width:"100%",display:"flex",overflow:"hidden"}},{default:E,counter:H,tail:()=>U},1032,["updateCounter","getCounter","getTail"])):(c(),G(Bt,{key:4,ref:"overflowRef",updateCounter:this.updateCounter,getCounter:this.getCounter,style:{width:"100%",display:"flex",overflow:"hidden"}},{default:E,counter:H},1032,["updateCounter","getCounter"])):T&&K?E().concat(K):E(),oe=g?()=>(c(),C("div",{class:M(`${r}-base-selection-popover`)},[$?(c(),C(ae,{key:0},[S(()=>E())],64)):(c(),C(ae,{key:1},[S(()=>this.selectedOptions.map(R))],64))],2)):void 0,ve=g?{show:this.showTagsPanel,trigger:"hover",overlap:!0,placement:"top",width:"trigger",onUpdateShow:this.onPopoverUpdateShow,theme:this.mergedTheme.peers.Popover,themeOverrides:this.mergedTheme.peerOverrides.Popover,...k}:null,ge=!this.selected&&(!this.active||!this.pattern&&!this.isComposing)?(c(),C("div",{key:5,class:M(`${r}-base-selection-placeholder ${r}-base-selection-overlay`)},[de("div",{class:M(`${r}-base-selection-placeholder__inner`)},[S(()=>this.placeholder)],2)],2)):null,le=i?(c(),C("div",{key:6,ref:"patternInputWrapperRef",class:M(`${r}-base-selection-tags`)},[S(()=>J),$?S(()=>null):(c(),C(ae,{key:1},[S(()=>U)],64)),S(()=>p)],2)):(c(),C("div",{key:7,ref:"multipleElRef",class:M(`${r}-base-selection-tags`),tabindex:l?void 0:0},[S(()=>J),S(()=>p)],10,zo));O=(X=>(c(),C(ae,{key:8},[g?(c(),G(En,Ie({key:0},ve,{scrollable:!0,style:"max-height: calc(var(--v-target-height) * 6.6);"}),{trigger:()=>le,default:oe},1040)):(c(),C(ae,{key:1},[S(()=>le)],64)),S(()=>ge)],64)))()}else if(i){const F=this.pattern||this.isComposing,R=this.active?!F:!this.selected,E=this.active?!1:this.selected;O=(U=>(c(),C("div",{key:9,ref:"patternInputWrapperRef",class:M(`${r}-base-selection-label`),title:this.patternInputFocused?void 0:_t(this.label)},[de("input",Ie(this.inputProps,{ref:"patternInputRef",class:`${r}-base-selection-input`,value:this.active?this.pattern:"",placeholder:"",readonly:l,disabled:l,tabindex:-1,autofocus:this.autofocus,onFocus:this.handlePatternInputFocus,onBlur:this.handlePatternInputBlur,onInput:this.handlePatternInputInput,onCompositionstart:this.handleCompositionStart,onCompositionend:this.handleCompositionEnd}),null,16,To),E?(c(),C("div",{class:M(`${r}-base-selection-label__render-label ${r}-base-selection-overlay`),key:"input"},[de("div",{class:M(`${r}-base-selection-overlay__wrapper`)},[b?(c(),C(ae,{key:0},[S(()=>b({option:this.selectedOption,handleClose:()=>{}}))],64)):(c(),C(ae,{key:1},[w?(c(),C(ae,{key:0},[S(()=>w(this.selectedOption,!0))],64)):(c(),C(ae,{key:1},[S(()=>De(this.label,this.selectedOption,!0))],64))],64))],2)],2)):S(()=>null),R?(c(),C("div",{class:M(`${r}-base-selection-placeholder ${r}-base-selection-overlay`),key:"placeholder"},[de("div",{class:M(`${r}-base-selection-overlay__wrapper`)},[S(()=>this.filterablePlaceholder)],2)],2)):S(()=>null),S(()=>p)],10,Fo)))()}else O=(F=>(c(),C("div",{key:10,ref:"singleElRef",class:M(`${r}-base-selection-label`),tabindex:this.disabled?void 0:0},[this.label!==void 0?(c(),C("div",{class:M(`${r}-base-selection-input`),title:_t(this.label),key:"input"},[de("div",{class:M(`${r}-base-selection-input__content`)},[b?(c(),C(ae,{key:0},[S(()=>b({option:this.selectedOption,handleClose:()=>{}}))],64)):(c(),C(ae,{key:1},[w?(c(),C(ae,{key:0},[S(()=>w(this.selectedOption,!0))],64)):(c(),C(ae,{key:1},[S(()=>De(this.label,this.selectedOption,!0))],64))],64))],2)],10,["title"])):(c(),C("div",{class:M(`${r}-base-selection-placeholder ${r}-base-selection-overlay`),key:"placeholder"},[de("div",{class:M(`${r}-base-selection-placeholder__inner`)},[S(()=>this.placeholder)],2)],2)),S(()=>p)],10,Mo)))();return c(),C("div",{ref:"selfRef",class:M([`${r}-base-selection`,this.rtlEnabled&&`${r}-base-selection--rtl`,this.themeClass,e&&`${r}-base-selection--${e}-status`,{[`${r}-base-selection--active`]:this.active,[`${r}-base-selection--selected`]:this.selected||this.active&&this.pattern,[`${r}-base-selection--disabled`]:this.disabled,[`${r}-base-selection--multiple`]:this.multiple,[`${r}-base-selection--focus`]:this.focused}]),style:Ne(this.cssVars),onClick:this.onClick,onMouseenter:this.handleMouseEnter,onMouseleave:this.handleMouseLeave,onKeydown:this.onKeydown,onFocusin:this.handleFocusin,onFocusout:this.handleFocusout,onMousedown:this.handleMouseDown},[S(()=>O),u?(c(),C("div",{key:0,class:M(`${r}-base-selection__border`)},null,2)):S(()=>null),u?(c(),C("div",{key:2,class:M(`${r}-base-selection__state-border`)},null,2)):S(()=>null)],46,Oo)}}),Po=he([W("select",`
 z-index: auto;
 outline: none;
 width: 100%;
 position: relative;
 font-weight: var(--n-font-weight);
 `),W("select-menu",`
 margin: 4px 0;
 box-shadow: var(--n-menu-box-shadow);
 `,[Kt({originalTransition:"background-color .3s var(--n-bezier), box-shadow .3s var(--n-bezier)"})])]);const Bo={...Re.props,to:wt.propTo,bordered:{type:Boolean,default:void 0},clearable:Boolean,clearCreatedOptionsOnClear:{type:Boolean,default:!0},clearFilterAfterSelect:{type:Boolean,default:!0},options:{type:Array,default:()=>[]},defaultValue:{type:[String,Number,Array],default:null},keyboard:{type:Boolean,default:!0},value:[String,Number,Array],placeholder:String,menuProps:Object,multiple:Boolean,size:String,menuSize:{type:String},filterable:Boolean,disabled:{type:Boolean,default:void 0},remote:Boolean,loading:Boolean,filter:Function,placement:{type:String,default:"bottom-start"},widthMode:{type:String,default:"trigger"},tag:Boolean,onCreate:Function,fallbackOption:{type:[Function,Boolean],default:void 0},show:{type:Boolean,default:void 0},showArrow:{type:Boolean,default:!0},maxTagCount:[Number,String],ellipsisTagPopoverProps:Object,consistentMenuWidth:{type:Boolean,default:!0},virtualScroll:{type:Boolean,default:!0},labelField:{type:String,default:"label"},valueField:{type:String,default:"value"},childrenField:{type:String,default:"children"},renderLabel:Function,renderOption:Function,renderTag:Function,"onUpdate:value":[Function,Array],inputProps:Object,nodeProps:Function,ignoreComposition:{type:Boolean,default:!0},showOnFocus:Boolean,onUpdateValue:[Function,Array],onBlur:[Function,Array],onClear:[Function,Array],onFocus:[Function,Array],onScroll:[Function,Array],onSearch:[Function,Array],onUpdateShow:[Function,Array],"onUpdate:show":[Function,Array],displayDirective:{type:String,default:"show"},resetMenuOnOptionsChange:{type:Boolean,default:!0},status:String,showCheckmark:{type:Boolean,default:!0},scrollbarProps:Object,onChange:[Function,Array],items:Array};var $o=be({name:"Select",props:Bo,slots:Object,setup(e){const{mergedClsPrefixRef:t,mergedBorderedRef:o,namespaceRef:l,inlineThemeDisabled:i,mergedComponentPropsRef:d}=Xe(e),u=Re("Select","-select",Po,Yn,e,t),r=I(e.defaultValue),k=ie(e,"value"),f=Tt(k,r),b=I(!1),w=I(""),$=Un(e,["items","options"]),T=I([]),g=I([]),p=P(()=>g.value.concat(T.value).concat($.value)),O=P(()=>{const{filter:n}=e;if(n)return n;const{labelField:h,valueField:z}=e;return(L,B)=>{if(!B)return!1;const _=B[h];if(typeof _=="string")return mt(L,_);const V=B[z];return typeof V=="string"?mt(L,V):typeof V=="number"?mt(L,String(V)):!1}}),F=P(()=>{if(e.remote)return $.value;{const{value:n}=p,{value:h}=w;return!h.length||!e.filterable?n:Co(n,O.value,h,e.childrenField)}}),R=P(()=>{const{valueField:n,childrenField:h}=e,z=xo(n,h);return Zn(F.value,z)}),E=P(()=>ko(p.value,e.valueField,e.childrenField)),U=I(!1),H=Tt(ie(e,"show"),U),K=I(null),J=I(null),oe=I(null),{localeRef:ve}=Lt("Select"),ge=P(()=>e.placeholder??ve.value.placeholder),le=[],X=I(new Map),v=P(()=>{const{fallbackOption:n}=e;if(n===void 0){const{labelField:h,valueField:z}=e;return L=>({[h]:String(L),[z]:L})}return n===!1?!1:h=>Object.assign(n(h),{value:h})});function x(n){const h=e.remote,{value:z}=X,{value:L}=E,{value:B}=v,_=[];return n.forEach(V=>{if(L.has(V))_.push(L.get(V));else if(h&&z.has(V))_.push(z.get(V));else if(B){const re=B(V);re&&_.push(re)}}),_}const N=P(()=>{if(e.multiple){const{value:n}=f;return Array.isArray(n)?x(n):[]}return null}),A=P(()=>{const{value:n}=f;return!e.multiple&&!Array.isArray(n)?n===null?null:x([n])[0]||null:null}),Z=Nn(e,{mergedSize:n=>{var B,_;const{size:h}=e;if(h)return h;const{mergedSize:z}=n||{};if(z!=null&&z.value)return z.value;const L=(_=(B=d==null?void 0:d.value)==null?void 0:B.Select)==null?void 0:_.size;return L||"medium"}}),{mergedSizeRef:Y,mergedDisabledRef:j,mergedStatusRef:Q}=Z;function q(n,h){const{onChange:z,"onUpdate:value":L,onUpdateValue:B}=e,{nTriggerFormChange:_,nTriggerFormInput:V}=Z;z&&we(z,n,h),B&&we(B,n,h),L&&we(L,n,h),r.value=n,_(),V()}function se(n){const{onBlur:h}=e,{nTriggerFormBlur:z}=Z;h&&we(h,n),z()}function ue(){const{onClear:n}=e;n&&we(n)}function a(n){const{onFocus:h,showOnFocus:z}=e,{nTriggerFormFocus:L}=Z;h&&we(h,n),L(),z&&me()}function m(n){const{onSearch:h}=e;h&&we(h,n)}function te(n){const{onScroll:h}=e;h&&we(h,n)}function pe(){var z;const{remote:n,multiple:h}=e;if(n){const{value:L}=X;if(h){const{valueField:B}=e;(z=N.value)==null||z.forEach(_=>{L.set(_[B],_)})}else{const B=A.value;B&&L.set(B[e.valueField],B)}}}function ze(n){const{onUpdateShow:h,"onUpdate:show":z}=e;h&&we(h,n),z&&we(z,n),U.value=n}function me(){j.value||(ze(!0),U.value=!0,e.filterable&&et())}function fe(){ze(!1)}function Te(){w.value="",g.value=le}const xe=I(!1);function Ce(){e.filterable&&(xe.value=!0)}function We(){e.filterable&&(xe.value=!1,H.value||Te())}function Ke(){j.value||(H.value?e.filterable?et():fe():me())}function Pe(n){var h,z;(z=(h=oe.value)==null?void 0:h.selfRef)!=null&&z.contains(n.relatedTarget)||(b.value=!1,se(n),fe())}function Be(n){a(n),b.value=!0}function je(){b.value=!0}function Ue(n){var h;(h=K.value)!=null&&h.$el.contains(n.relatedTarget)||(b.value=!1,se(n),fe())}function He(){var n;(n=K.value)==null||n.focus(),fe()}function Ae(n){var h;H.value&&((h=K.value)!=null&&h.$el.contains(Kn(n))||fe())}function Le(n){if(!Array.isArray(n))return[];if(v.value)return Array.from(n);{const{remote:h}=e,{value:z}=E;if(h){const{value:L}=X;return n.filter(B=>z.has(B)||L.has(B))}else return n.filter(L=>z.has(L))}}function ye(n){s(n.rawNode)}function s(n){if(j.value)return;const{tag:h,remote:z,clearFilterAfterSelect:L,valueField:B}=e;if(h&&!z){const{value:_}=g,V=_[0]||null;if(V){const re=T.value;re.length?re.push(V):T.value=[V],g.value=le}}if(z&&X.value.set(n[B],n),e.multiple){const _=Le(f.value),V=_.findIndex(re=>re===n[B]);if(~V){if(_.splice(V,1),h&&!z){const re=y(n[B]);~re&&(T.value.splice(re,1),L&&(w.value=""))}}else _.push(n[B]),L&&(w.value="");q(_,x(_))}else{if(h&&!z){const _=y(n[B]);~_?T.value=[T.value[_]]:T.value=le}Je(),fe(),q(n[B],n)}}function y(n){return T.value.findIndex(h=>h[e.valueField]===n)}function ce(n){H.value||me();const{value:h}=n.target;w.value=h;const{tag:z,remote:L}=e;if(m(h),z&&!L){if(!h){g.value=le;return}const{onCreate:B}=e,_=B?B(h):{[e.labelField]:h,[e.valueField]:h},{valueField:V,labelField:re}=e;$.value.some(ke=>ke[V]===_[V]||ke[re]===_[re])||T.value.some(ke=>ke[V]===_[V]||ke[re]===_[re])?g.value=le:g.value=[_]}}function ct(n){n.stopPropagation();const{multiple:h,tag:z,remote:L,clearCreatedOptionsOnClear:B}=e;!h&&e.filterable&&fe(),z&&!L&&B&&(T.value=le),ue(),h?q([],[]):q(null,null)}function dt(n){!Ge(n,"action")&&!Ge(n,"empty")&&!Ge(n,"header")&&n.preventDefault()}function ut(n){te(n)}function Qe(n){var h,z,L,B,_;if(!e.keyboard){n.preventDefault();return}switch(n.key){case" ":if(e.filterable)break;n.preventDefault();case"Enter":if(!((h=K.value)!=null&&h.isComposing)){if(H.value){const V=(z=oe.value)==null?void 0:z.getPendingTmNode();V?ye(V):e.filterable||(fe(),Je())}else if(me(),e.tag&&xe.value){const V=g.value[0];if(V){const re=V[e.valueField],{value:ke}=f;e.multiple&&Array.isArray(ke)&&ke.includes(re)||s(V)}}}n.preventDefault();break;case"ArrowUp":if(n.preventDefault(),e.loading)return;H.value&&((L=oe.value)==null||L.prev());break;case"ArrowDown":if(n.preventDefault(),e.loading)return;H.value?(B=oe.value)==null||B.next():me();break;case"Escape":H.value&&(jn(n),fe()),(_=K.value)==null||_.focus()}}function Je(){var n;(n=K.value)==null||n.focus()}function et(){var n;(n=K.value)==null||n.focusInput()}function ft(){var n;H.value&&((n=J.value)==null||n.syncPosition())}pe(),Ee(ie(e,"options"),pe);const ht={focus:()=>{var n;(n=K.value)==null||n.focus()},focusInput:()=>{var n;(n=K.value)==null||n.focusInput()},blur:()=>{var n;(n=K.value)==null||n.blur()},blurInput:()=>{var n;(n=K.value)==null||n.blurInput()}},tt=P(()=>{const{self:{menuBoxShadow:n}}=u.value;return{"--n-menu-box-shadow":n}}),Me=i?Ye("select",void 0,tt,e):void 0;return{...ht,mergedStatus:Q,mergedClsPrefix:t,mergedBordered:o,namespace:l,treeMate:R,isMounted:Wn(),triggerRef:K,menuRef:oe,pattern:w,uncontrolledShow:U,mergedShow:H,adjustedTo:wt(e),uncontrolledValue:r,mergedValue:f,followerRef:J,localizedPlaceholder:ge,selectedOption:A,selectedOptions:N,mergedSize:Y,mergedDisabled:j,focused:b,activeWithoutMenuOpen:xe,inlineThemeDisabled:i,onTriggerInputFocus:Ce,onTriggerInputBlur:We,handleTriggerOrMenuResize:ft,handleMenuFocus:je,handleMenuBlur:Ue,handleMenuTabOut:He,handleTriggerClick:Ke,handleToggle:ye,handleDeleteOption:s,handlePatternInput:ce,handleClear:ct,handleTriggerBlur:Pe,handleTriggerFocus:Be,handleKeydown:Qe,handleMenuAfterLeave:Te,handleMenuClickOutside:Ae,handleMenuScroll:ut,handleMenuKeydown:Qe,handleMenuMousedown:dt,mergedTheme:u,cssVars:i?void 0:tt,themeClass:Me==null?void 0:Me.themeClass,onRender:Me==null?void 0:Me.onRender}},render(){return c(),C("div",{class:M(`${this.mergedClsPrefix}-select`)},[Dn(Vn,null,{_:1,default:Oe(()=>[(c(),G(Hn,null,{_:1,default:Oe(()=>(c(),G(Io,{ref:"triggerRef",inlineThemeDisabled:this.inlineThemeDisabled,status:this.mergedStatus,inputProps:this.inputProps,clsPrefix:this.mergedClsPrefix,showArrow:this.showArrow,maxTagCount:this.maxTagCount,ellipsisTagPopoverProps:this.ellipsisTagPopoverProps,bordered:this.mergedBordered,active:this.activeWithoutMenuOpen||this.mergedShow,pattern:this.pattern,placeholder:this.localizedPlaceholder,selectedOption:this.selectedOption,selectedOptions:this.selectedOptions,multiple:this.multiple,renderTag:this.renderTag,renderLabel:this.renderLabel,filterable:this.filterable,clearable:this.clearable,disabled:this.mergedDisabled,size:this.mergedSize,theme:this.mergedTheme.peers.InternalSelection,labelField:this.labelField,valueField:this.valueField,themeOverrides:this.mergedTheme.peerOverrides.InternalSelection,loading:this.loading,focused:this.focused,onClick:this.handleTriggerClick,onDeleteOption:this.handleDeleteOption,onPatternInput:this.handlePatternInput,onClear:this.handleClear,onBlur:this.handleTriggerBlur,onFocus:this.handleTriggerFocus,onKeydown:this.handleKeydown,onPatternBlur:this.onTriggerInputBlur,onPatternFocus:this.onTriggerInputFocus,onResize:this.handleTriggerOrMenuResize,ignoreComposition:this.ignoreComposition},{_:1,arrow:Oe(()=>{var e,t;return[(t=(e=this.$slots).arrow)==null?void 0:t.call(e)]})},8,["inlineThemeDisabled","status","inputProps","clsPrefix","showArrow","maxTagCount","ellipsisTagPopoverProps","bordered","active","pattern","placeholder","selectedOption","selectedOptions","multiple","renderTag","renderLabel","filterable","clearable","disabled","size","theme","labelField","valueField","themeOverrides","loading","focused","onClick","onDeleteOption","onPatternInput","onClear","onBlur","onFocus","onKeydown","onPatternBlur","onPatternFocus","onResize","ignoreComposition"])))})),(c(),G(Xn,{ref:"followerRef",show:this.mergedShow,to:this.adjustedTo,teleportDisabled:this.adjustedTo===wt.tdkey,containerClass:this.namespace,width:this.consistentMenuWidth?"target":void 0,minWidth:"target",placement:this.placement},{_:1,default:Oe(()=>(c(),G(Wt,{name:"fade-in-scale-up-transition",appear:this.isMounted,onAfterLeave:this.handleMenuAfterLeave},{_:1,default:Oe(()=>{var e,t,o;return this.mergedShow||this.displayDirective==="show"?((e=this.onRender)==null||e.call(this),qn((c(),G(wo,Ie(this.menuProps,{ref:"menuRef",onResize:this.handleTriggerOrMenuResize,inlineThemeDisabled:this.inlineThemeDisabled,virtualScroll:this.consistentMenuWidth&&this.virtualScroll,class:[`${this.mergedClsPrefix}-select-menu`,this.themeClass,(t=this.menuProps)==null?void 0:t.class],clsPrefix:this.mergedClsPrefix,focusable:!0,labelField:this.labelField,valueField:this.valueField,autoPending:!0,nodeProps:this.nodeProps,theme:this.mergedTheme.peers.InternalSelectMenu,themeOverrides:this.mergedTheme.peerOverrides.InternalSelectMenu,treeMate:this.treeMate,multiple:this.multiple,size:this.menuSize,renderOption:this.renderOption,renderLabel:this.renderLabel,value:this.mergedValue,style:[(o=this.menuProps)==null?void 0:o.style,this.cssVars],onToggle:this.handleToggle,onScroll:this.handleMenuScroll,onFocus:this.handleMenuFocus,onBlur:this.handleMenuBlur,onKeydown:this.handleMenuKeydown,onTabOut:this.handleMenuTabOut,onMousedown:this.handleMenuMousedown,show:this.mergedShow,showCheckmark:this.showCheckmark,resetMenuOnOptionsChange:this.resetMenuOnOptionsChange,scrollbarProps:this.scrollbarProps}),{_:1,empty:Oe(()=>{var l,i;return[(i=(l=this.$slots).empty)==null?void 0:i.call(l)]}),header:Oe(()=>{var l,i;return[(i=(l=this.$slots).header)==null?void 0:i.call(l)]}),action:Oe(()=>{var l,i;return[(i=(l=this.$slots).action)==null?void 0:i.call(l)]})},16,["onResize","inlineThemeDisabled","virtualScroll","class","clsPrefix","labelField","valueField","nodeProps","theme","themeOverrides","treeMate","multiple","size","renderOption","renderLabel","value","style","onToggle","onScroll","onFocus","onBlur","onKeydown","onTabOut","onMousedown","show","showCheckmark","resetMenuOnOptionsChange","scrollbarProps"])),this.displayDirective==="show"?[[Gn,this.mergedShow],[Mt,this.handleMenuClickOutside,void 0,{capture:!0}]]:[[Mt,this.handleMenuClickOutside,void 0,{capture:!0}]])):null})},8,["appear","onAfterLeave"])))},8,["show","to","teleportDisabled","containerClass","width","placement"]))])})],2)}});export{to as E,$o as S,bt as T,ro as V,wo as a,xo as c,pt as m};
