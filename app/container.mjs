// Container-only entry point. Compose must keep the published host port on loopback.
import {createServer} from './server.mjs';
import {createPublicServer} from './public-server.mjs';
const port=Number(process.env.PORT??3027);
const server=process.env.PUBLIC_SERVICE==='1'?await createPublicServer({storeDir:'/app/data/public',env:process.env}):createServer();
server.listen(port,'0.0.0.0',()=>console.log(`Career Search container listening on ${port}`));
if(process.env.MAIL_INGRESS_PORT){const ingressPort=Number(process.env.MAIL_INGRESS_PORT);server.ingress.listen(ingressPort,'0.0.0.0',()=>console.log(`Mail ingress listening on ${ingressPort}`));}
