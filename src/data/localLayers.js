import { localGeoJsonServices } from './localGeojson.js';
import { createInfrastructureLayers } from './infrastructure.js';

const [datacenters, dams] = createInfrastructureLayers(localGeoJsonServices);

export default [datacenters, dams];
