import { randomBytes, scrypt, timingSafeEqual, createHmac } from 'node:crypto';

const derive = (password:string,salt:string) => new Promise<Buffer>((resolve,reject) => scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024},(error,key)=>error?reject(error):resolve(key)));
export async function passwordHash(password:string) {
  const salt=randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await derive(password,salt)).toString('hex')}`;
}
export async function passwordMatches(password:string, encoded:string) {
  const [algorithm,salt,hash]=encoded.split(':');
  if(algorithm!=='scrypt' || !salt || !hash || !/^[a-f0-9]{128}$/.test(hash)) return false;
  return timingSafeEqual(await derive(password,salt),Buffer.from(hash,'hex'));
}
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes:Buffer) {
  let value=0,bits=0,result='';
  for(const byte of bytes) {value=(value<<8)|byte;bits+=8;while(bits>=5){bits-=5;result+=alphabet[(value>>>bits)&31];}}
  if(bits)result+=alphabet[(value<<(5-bits))&31];
  return result;
}
function decode32(value:string) {
  let buffer=0,bits=0;const bytes:number[]=[];
  for(const char of value){const n=alphabet.indexOf(char);if(n<0)throw new Error('Invalid TOTP secret');buffer=(buffer<<5)|n;bits+=5;if(bits>=8){bits-=8;bytes.push((buffer>>>bits)&255);}}
  return Buffer.from(bytes);
}
export function totp(secret:string,step:number,digits=6) {
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(step));
  const hash=createHmac('sha1',decode32(secret)).update(counter).digest();
  const offset=hash[hash.length-1]!&15;
  return String((hash.readUInt32BE(offset)&0x7fffffff)%10**digits).padStart(digits,'0');
}
export function verifyTotp(secret:string,code:string,lastStep:number,now=Date.now()) {
  if(!/^\d{6}$/.test(code))return null;
  const step=Math.floor(now/30000);
  for(const candidate of [step,step-1,step+1])if(candidate>lastStep && timingSafeEqual(Buffer.from(code),Buffer.from(totp(secret,candidate))))return candidate;
  return null;
}
export function csrfToken(session:string,key:string) {return createHmac('sha256',key).update(`cms-csrf:${session}`).digest('hex');}
export function safeEqual(a:string,b:string) {const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y);}
