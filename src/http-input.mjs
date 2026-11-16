const failure=(message,status)=>Object.assign(new Error(message),{status});
// Stop retaining input at the limit without destroying the socket before a 4xx reply.
export async function readJsonBody(req,maximum){
 const encoding=req.headers['content-encoding'];
 if(encoding&&encoding.toLowerCase()!=='identity')throw failure('Compressed request bodies are not supported.',415);
 if(Number(req.headers['content-length']||0)>maximum)throw failure('Request body exceeds limit.',413);
 const data=await new Promise((resolve,reject)=>{
  let size=0,chunks=[];
  const cleanup=()=>{req.off('data',onData);req.off('end',onEnd);req.off('aborted',onAbort);req.off('error',onError);};
  const failed=error=>{cleanup();chunks=[];req.on('error',()=>{});req.resume();reject(error);};
  const onData=chunk=>{size+=chunk.length;if(size>maximum)failed(failure('Request body exceeds limit.',413));else chunks.push(chunk);};
  const onEnd=()=>{cleanup();resolve(Buffer.concat(chunks));};
  const onAbort=()=>failed(failure('Request aborted.',400)),onError=e=>failed(e);
  req.on('data',onData);req.once('end',onEnd);req.once('aborted',onAbort);req.once('error',onError);
 });
 let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{throw failure('Malformed UTF-8 JSON.',400);}
 const pending=[[value,0]];let nodes=0;
 while(pending.length){const [v,depth]=pending.pop();if(++nodes>200000||depth>64)throw failure('JSON structure exceeds limit.',413);if(v&&typeof v==='object')for(const item of Object.values(v))pending.push([item,depth+1]);}
 return value;
}
export const isLoopback=address=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
