// Container-only entry point. Compose must keep the published host port on loopback.
import {createServer} from './server.mjs';
const port=Number(process.env.PORT??3027);
const server=createServer();
server.listen(port,'0.0.0.0',()=>console.log(`Career Search container listening on ${port}`));
