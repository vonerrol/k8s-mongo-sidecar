'use strict';

const dns = require('dns');
const os = require('os');
const { promisify } = require('util');

const { DateTime } = require('luxon');
const ip = require('ip');

const mongo = require('./mongo');
const k8s = require('./k8s');
const config = require('./config');


const loopSleepSeconds = config.loopSleepSeconds;
const unhealthySeconds = config.unhealthySeconds;

let hostIp = false;
let hostIpAndPort = false;

const init = async() => {
  // Borrowed from here: http://stackoverflow.com/questions/3653065/get-local-ip-address-in-node-js
  const hostName = os.hostname();
  const lookup = promisify(dns.lookup);
  try {
    hostIp = await lookup(hostName);
    hostIp = hostIp.address;
    hostIpAndPort = hostIp + ':' + config.mongoPort;
  } catch (err) {
    return Promise.reject(err);
  }

  try {
    await k8s.init();
  } catch (err) {
    return Promise.reject(err);
  }

  return;
};

const workloop = async() => {
  if (!hostIp || !hostIpAndPort) {
    throw new Error('Must initialize with the host machine\'s addr');
  }

  let pods = [];
  let client = null;
  try {
    pods = await k8s.getMongoPods();
    client = await mongo.getClient();
  } catch (err) {
    return finish(err);
  }

  // Lets remove any pods that aren't running or haven't been assigned an IP address yet
  for (let i = pods.length - 1; i >= 0; i--) {
    const pod = pods[i];
    if (pod.status.phase !== 'Running' || !pod.status.podIP) {
      pods.splice(i, 1);
    }
  }

  if (!pods.length) {
    return finish('No pods are currently running, probably just give them some time.');
  }

  const db = client.db(config.mongoDatabase);

  // Lets try and get the rs status for this mongo instance
  // If it works with no errors, they are in the rs
  // If we get a specific error, it means they aren't in the rs
  try {
    const status = await mongo.replSetGetStatus(db);
    await inReplicaSet(db, pods, status);
    finish(null, client);
  } catch (err) {
    switch (err.code) {
    case 94:
      notInReplicaSet(db, pods)
        .then(() => finish(null, client))
        .catch(err => finish(err, client));
      break;
    case 93:
      invalidReplicaSet(db, pods)
        .then(() => finish(null, client))
        .catch(err => finish(err, client));
      break;
    default:
      finish(err, client);
    }
  }
};

const finish = (err, client) => {
  if (err) console.error('Error in workloop:', err);

  if (client) client.close();

  setTimeout(workloop, loopSleepSeconds * 1000);
};

const inReplicaSet = async (db, pods, status) => {
  // If we're already in a rs and we ARE the primary, do the work of the primary instance (i.e. adding others)
  // If we're already in a rs and we ARE NOT the primary, just continue, nothing to do
  // If we're already in a rs and NO ONE is a primary, elect someone to do the work for a primary
  const members = status.members;

  let primaryExists = false;
  for (const member of members) {
    if (member.state === 1) {
      if (member.self) return primaryWork(db, pods, members, false);

      primaryExists = true;
      break;
    }
  }

  if (!primaryExists && podElection(pods)) {
    console.info('Pod has been elected as a secondary to do primary work');
    return primaryWork(db, pods, members, true);
  }

  return;
};

const primaryWork = async (db, pods, members, shouldForce) => {

  // Loop over all the pods we have and see if any of them aren't in the current rs members array
  // If they aren't in there, add them
  const addrToAdd = addrToAddLoop(pods, members);
  const addrToRemove = addrToRemoveLoop(members);

  if (addrToAdd.length || addrToRemove.length) {
    console.info('Addresses to add:    ', addrToAdd);
    console.info('Addresses to remove: ', addrToRemove);

    return mongo.addNewReplSetMembers(db, addrToAdd, addrToRemove, shouldForce);
  }

  return;
};

const notInReplicaSet = async (db, pods) => {
  try {
    const createTestRequest = pod => mongo.isInReplSet(pod.status.podIP);

    // If we're not in a rs and others ARE in the rs, just continue, another path will ensure we will get added
    // If we're not in a rs and no one else is in a rs, elect one to kick things off
    let testRequests = [];
    for (const pod of pods) {
      if (pod.status.phase === 'Running') {
        testRequests.push(createTestRequest(pod));
      }
    }

    const results = await Promise.all(testRequests);

    for (const result of results) {
      if (result) return; // There's one in a rs, nothing to do
    }

    if (podElection(pods)) {
      console.info('Pod has been elected for replica set initialization');
      const primary = pods[0]; // After the sort election, the 0-th pod should be the primary.
      const primaryStableNetworkAddressAndPort = getPodStableNetworkAddressAndPort(primary);
      // Prefer the stable network ID over the pod IP, if present.
      const primaryAddressAndPort = primaryStableNetworkAddressAndPort || hostIpAndPort;
      return mongo.initReplSet(db, primaryAddressAndPort);
    }

    return;
  } catch (err) {
    return Promise.reject(err);
  }
};

const invalidReplicaSet = async (db, pods, status) => {

  // The replica set config has become invalid, probably due to catastrophic errors like all nodes going down
  // this will force re-initialize the replica set on this node. There is a small chance for data loss here
  // because it is forcing a reconfigure, but chances are recovering from the invalid state is more important
  let members = [];
  if (status && status.members) {
    members = status.members;
  }

  console.warn('Invalid replica set');
  if (!podElection(pods)) {
    console.info('Didn\'t win the pod election, doing nothing');
    return;
  }

  console.info('Won the pod election, forcing re-initialization');
  const addrToAdd = addrToAddLoop(pods, members);
  const addrToRemove = addrToRemoveLoop(members);

  return mongo.addNewReplSetMembers(db, addrToAdd, addrToRemove, true);
};

const podElection = pods => {
  // Because all the pods are going to be running this code independently, we need a way to consistently find the same
  // node to kick things off, the easiest way to do that is convert their ips into longs and find the highest
  pods.sort((a, b) => {
    const aIpVal = ip.toLong(a.status.podIP);
    const bIpVal = ip.toLong(b.status.podIP);
    if (aIpVal < bIpVal) return -1;
    if (aIpVal > bIpVal) return 1;
    return 0; // Shouldn't get here... all pods should have different ips
  });

  // Are we the lucky one?
  return pods[0].status.podIP === hostIp;
};

const addrToAddLoop = (pods, members) => {
  let addrToAdd = [];
  for (const pod of pods) {
    if (pod.status.phase !== 'Running') {
      continue;
    }

    const podIpAddr = getPodIpAddressAndPort(pod);
    const podStableNetworkAddr = getPodStableNetworkAddressAndPort(pod);
    let podInRs = false;

    for (const member of members) {
      if (member.name === podIpAddr || member.name === podStableNetworkAddr || member.ip === pod.status.podIP) {
        /* If we have the pod's ip or the stable network address already in the config, no need to read it. Checks both the pod IP and the
        * stable network ID - we don't want any duplicates - either one of the two is sufficient to consider the node present. */
        podInRs = true;
        break;
      }
    }

    if (!podInRs) {
      // If the node was not present, we prefer the stable network ID, if present.
      const addrToUse = podStableNetworkAddr || podIpAddr;
      addrToAdd.push(addrToUse);
    }
  }
  return addrToAdd;
};

const addrToRemoveLoop = members => {
  let addrToRemove = [];
  for (const member of members) {
    if (memberShouldBeRemoved(member)) {
      addrToRemove.push(member.name);
    }
  }
  return addrToRemove;
};

const memberShouldBeRemoved = member => !member.health
      && DateTime.local().minus({ seconds: unhealthySeconds }) > DateTime.fromISO(member.lastHeartbeatRecv);

/**
 * @param pod this is the Kubernetes pod, containing the info.
 * @returns string - podIp the pod's IP address with the port from config attached at the end. Example
 * WWW.XXX.YYY.ZZZ:27017. It returns undefined, if the data is insufficient to retrieve the IP address.
 */
const getPodIpAddressAndPort = pod => {
  if (!pod || !pod.status || !pod.status.podIP) return;

  return `${pod.status.podIP}:${config.mongoPort}`;
};

/**
 * Gets the pod's address. 
 * 
 * If the pod spec contains both hostname and subdomain and the subdomain matches the service name, the address will be in the format:
 * 
 * '<hostname>.<mongo-kubernetes-service>.<pod-namespace>.svc.cluster.local:<mongo-port>'
 * 
 * See:<a href="https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/#pod-s-hostname-and-subdomain-fields">DNS for Services and Pods - Pod's hostname and subdomain fields</a>.
 * 
 * Otherwise, if the pod belongs to a stateful set, the address will be in the format:
 * 
 * '<pod-name>.<mongo-kubernetes-service>.<pod-namespace>.svc.cluster.local:<mongo-port>'
 * 
 * See:<a href="https://kubernetes.io/docs/concepts/abstractions/controllers/statefulsets/#stable-network-id">Stateful Sets - Stable Network ID</a>. 
 * 
 * If those are not set, then simply the pod's IP is returned.
 * 
 * @param pod the Kubernetes pod, containing the information from the k8s client.
 * @returns string the k8s MongoDB stable network address, or undefined.
 */
const getPodStableNetworkAddressAndPort = pod => {
  if (!config.k8sMongoServiceName || !pod || !pod.metadata || !pod.metadata.name || !pod.metadata.namespace) return;

  let hostname;

  if (pod.spec && pod.spec.hostname && pod.spec.subdomain && pod.spec.subdomain === config.k8sMongoServiceName) {
    hostname = pod.spec.hostname;
  } else {
    hosntame = pod.metadata.name
  }

  return `${hostname}.${config.k8sMongoServiceName}.${pod.metadata.namespace}.svc.${config.k8sClusterDomain}:${config.mongoPort}`;
};

module.exports = {
  init,
  workloop
};
