import { network } from "hardhat";
import { deployCreate2Token, loadDeploymentWallet, parseSalt } from "./lib/create2-deployment.js";

const salt = parseSalt(process.env.CREATE2_SALT);
const wallet = loadDeploymentWallet();
const connection = await network.create();

try {
  const result = await deployCreate2Token(connection, salt, wallet);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await connection.close();
}
