import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../db/database.js';
import { contentCipher } from '../security/crypto.js';
import { proofSchema, type DeviceProof } from '../security/device-signatures.js';
import { deviceService } from '../services/devices.js';
import { ApiError } from '../services/policy.js';
import { dispatchCampaigns } from '../services/campaigns.js';
export function deviceRoutes(db:Database,key:string) {
  const router=Router(); const service=deviceService(db,contentCipher(key));
  router.use((req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    if(req.method!=='POST' || req.originalUrl.includes('?')) throw new ApiError(400,'INVALID_DEVICE_REQUEST');
    const parsed=proofSchema.safeParse({deviceId:req.header('X-Device-Id'),timestamp:req.header('X-Device-Timestamp'),nonce:req.header('X-Device-Nonce'),signature:req.header('X-Device-Signature')});
    if(!parsed.success) throw new ApiError(401,'DEVICE_PROOF_REQUIRED');
    res.locals.proof={...parsed.data,method:req.method,path:res.locals.externalUrl ?? req.originalUrl,body:res.locals.rawBody ?? Buffer.alloc(0)} satisfies DeviceProof;
    next();
  });
  router.post('/enroll',async(req,res)=>res.json(await service.enroll(res.locals.proof,req.body)));
  router.post('/heartbeat',async(req,res)=>{
    const response=await service.heartbeat(res.locals.proof,req.body);
    // A verified phone poll also wakes scheduled work on hosts that idle Node.
    await dispatchCampaigns(db,contentCipher(key));
    res.json(response);
  });
  router.post('/fcm-token',async(req,res)=>res.json(await service.fcmToken(res.locals.proof,req.body)));
  router.post('/inbound-control',async(req,res)=>res.json(await service.inbound(res.locals.proof,req.body)));
  router.post('/jobs/claim',async(req,res)=>res.json(await service.claim(res.locals.proof,req.body)));
  router.post('/jobs/:id/authorize',async(req,res)=>res.json(await service.authorize(res.locals.proof,z.uuid().parse(req.params.id),req.body)));
  router.post('/jobs/:id/events',async(req,res)=>res.json(await service.event(res.locals.proof,z.uuid().parse(req.params.id),req.body)));
  router.use(()=>{throw new ApiError(404,'NOT_FOUND');});
  return router;
}
