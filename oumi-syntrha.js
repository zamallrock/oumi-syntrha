import fs from "fs";
import chalk from "chalk";
import { ethers } from "ethers";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

const RPC_URL = "https://finney.uomi.ai/";
const CHAIN_ID = 4386;

const SYN_ADDRESS = "0x2922B2Ca5EB6b02fc5E1EBE57Fc1972eBB99F7e0";
const WUOMI_ADDRESS = "0x5FCa78E132dF589c1c799F906dC867124a2567b2";
const SWAP_ROUTER_ADDRESS = "0x197EEAd5Fe3DB82c4Cd55C5752Bc87AEdE11f230";
const LP_MANAGER_ADDRESS = "0x906515Dc7c32ab887C8B8Dce6463ac3a7816Af38";
const CHAIN_NAME = "UOMI";

const SWAPS_PER_WALLET = 9;

const UOMI_SWAP_MIN = 0.001;
const UOMI_SWAP_MAX = 0.005;

const WUOMI_LP_MIN = 0.001;
const WUOMI_LP_MAX = 0.005;

const DELAY_SWAP_MIN = 30 * 1000;
const DELAY_SWAP_MAX = 60 * 1000;
const DELAY_CYCLE_MIN = 60 * 60 * 1000;
const DELAY_CYCLE_MAX = 2 * 60 * 60 * 1000;

const GAS_LIMIT_SWAP = 750_000;
const GAS_LIMIT_APPROVE = 100_000;
const GAS_LIMIT_MINT = 500_000;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

const SWAP_ROUTER_ABI = [
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) external payable"
];

const LP_MANAGER_ABI = [
  "function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function factory() view returns (address)"
];

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"
];

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
];

function logHeader() {
  console.log(chalk.cyan("================================================="));
  console.log(chalk.magentaBright("     ✪ ZAMALLROCK | UOMI TESTNET AUTO BOT ✪"));
  console.log(chalk.cyan("        Mode: Multi Wallet Continuous"));
  console.log(chalk.cyan("=================================================\n"));
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function randomInRange(min, max, fixed = 4) {
  const r = Math.random() * (max - min) + min;
  return parseFloat(r.toFixed(fixed));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) {
    return new SocksProxyAgent(proxyUrl);
  } else {
    return new HttpsProxyAgent(proxyUrl);
  }
}

function readListFile(filename) {
  try {
    if (!fs.existsSync(filename)) return [];
    const raw = fs.readFileSync(filename, "utf8");
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch (e) {
    console.error("Failed reading", filename, e.message);
    return [];
  }
}

const privateKeys = readListFile("privatekey.txt");
const proxies = readListFile("proxy.txt");

if (privateKeys.length === 0) {
  console.error(chalk.red("No private keys found in privatekey.txt. Exiting."));
  process.exit(1);
}

function getProviderWithAgent(proxyUrl) {
  try {
    if (!proxyUrl) {
      return new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: CHAIN_NAME });
    }
    const agent = createAgent(proxyUrl);
    return new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: CHAIN_NAME }, { fetchOptions: { agent } });
  } catch (err) {
    console.log(chalk.yellow("Provider with agent failed, falling back to direct provider:"), err.message);
    return new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: CHAIN_NAME });
  }
}

const nonceTracker = {};

async function getNextNonce(provider, walletAddress) {
  if (!ethers.isAddress(walletAddress)) throw new Error("Invalid address for nonce");
  const pendingNonce = await provider.getTransactionCount(walletAddress, "pending");
  const lastUsed = nonceTracker[walletAddress] ?? (pendingNonce - 1);
  const next = Math.max(pendingNonce, lastUsed + 1);
  nonceTracker[walletAddress] = next;
  return next;
}

async function getPoolAddress(provider) {
  const lpManager = new ethers.Contract(LP_MANAGER_ADDRESS, LP_MANAGER_ABI, provider);
  const factoryAddress = await lpManager.factory();
  const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
  const poolAddress = await factory.getPool(SYN_ADDRESS, WUOMI_ADDRESS, 3000);
  return poolAddress;
}

async function getCurrentPrice(provider, poolAddress) {
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const slot0 = await pool.slot0();
  const sqrtPriceX96 = slot0[0] ?? slot0.sqrtPriceX96;
  const price = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  return price;
}

async function performSwap(wallet, amountUOMI) {
  try {
    const router = new ethers.Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);
    const amountInWei = ethers.parseUnits(amountUOMI.toString(), 18);
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

    const bal = await wallet.provider.getBalance(wallet.address);
    const balFormatted = parseFloat(ethers.formatEther(bal));
    if (balFormatted <= 0) throw new Error("Insufficient native balance for swap");

    const poolAddr = await getPoolAddress(wallet.provider);
    if (!poolAddr || poolAddr === ethers.ZeroAddress) throw new Error("Pool fee 3000 not found");
    const price = await getCurrentPrice(wallet.provider, poolAddr);
    if (!price || price === 0) throw new Error("Failed to read price");

    const estOut = amountUOMI / price;
    const amountOutMin = ethers.parseUnits((estOut * 0.95).toFixed(18), 18);

    const path = ethers.concat([WUOMI_ADDRESS, ethers.toBeHex(3000, 3), SYN_ADDRESS]);

    const wrapEth = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256"],
      ["0x0000000000000000000000000000000000000002", amountInWei]
    );

    const v3SwapExactIn = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "uint256", "bytes", "bool"],
      [wallet.address, amountInWei, amountOutMin, path, false]
    );

    let commandsBytes = "0x0b00";
    try {
      const callData = router.interface.encodeFunctionData("execute", [
        commandsBytes,
        [wrapEth, v3SwapExactIn],
        deadline
      ]);
      await wallet.provider.call({
        to: SWAP_ROUTER_ADDRESS,
        data: callData,
        from: wallet.address,
        value: amountInWei
      });
    } catch {
      commandsBytes = "0x0b";
      const altCallData = router.interface.encodeFunctionData("execute", [
        commandsBytes,
        [wrapEth, v3SwapExactIn],
        deadline
      ]);
      await wallet.provider.call({
        to: SWAP_ROUTER_ADDRESS,
        data: altCallData,
        from: wallet.address,
        value: amountInWei
      });
    }

    const tx = await router.execute(
      commandsBytes,
      [wrapEth, v3SwapExactIn],
      deadline,
      {
        gasLimit: GAS_LIMIT_SWAP,
        nonce: await getNextNonce(wallet.provider, wallet.address),
        value: amountInWei
      }
    );
    const receipt = await tx.wait();
    if (receipt.status === 0) throw new Error("Swap transaction reverted");
    return { success: true, txHash: tx.hash };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
}

async function performAddLp(wallet, amountWUOMI) {
  try {
    const provider = wallet.provider;
    const lpManagerContract = new ethers.Contract(LP_MANAGER_ADDRESS, LP_MANAGER_ABI, wallet);
    const synContract = new ethers.Contract(SYN_ADDRESS, ERC20_ABI, wallet);
    const wuomiContract = new ethers.Contract(WUOMI_ADDRESS, ERC20_ABI, wallet);

    const poolAddr = await getPoolAddress(provider);
    if (!poolAddr || poolAddr === ethers.ZeroAddress) throw new Error("Pool not found");
    const price = await getCurrentPrice(provider, poolAddr);
    if (!price || price === 0) throw new Error("Failed to read price");

    const amountSYN = amountWUOMI / price;
    const amountSYNWei = ethers.parseUnits(amountSYN.toFixed(18), 18);
    const amountWUOMIWei = ethers.parseUnits(amountWUOMI.toString(), 18);
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

    const synAllowance = await synContract.allowance(wallet.address, LP_MANAGER_ADDRESS);
    if (synAllowance < amountSYNWei) {
      const txA = await synContract.approve(LP_MANAGER_ADDRESS, amountSYNWei, {
        gasLimit: GAS_LIMIT_APPROVE,
        nonce: await getNextNonce(provider, wallet.address)
      });
      await txA.wait();
    }

    const wuomiAllowance = await wuomiContract.allowance(wallet.address, LP_MANAGER_ADDRESS);
    if (wuomiAllowance < amountWUOMIWei) {
      const txB = await wuomiContract.approve(LP_MANAGER_ADDRESS, amountWUOMIWei, {
        gasLimit: GAS_LIMIT_APPROVE,
        nonce: await getNextNonce(provider, wallet.address)
      });
      await txB.wait();
    }

    const params = {
      token0: SYN_ADDRESS,
      token1: WUOMI_ADDRESS,
      fee: 3000,
      tickLower: -887220,
      tickUpper: 887220,
      amount0Desired: amountSYNWei,
      amount1Desired: amountWUOMIWei,
      amount0Min: 0,
      amount1Min: 0,
      recipient: wallet.address,
      deadline: deadline
    };

    const tx = await lpManagerContract.mint(params, {
      gasLimit: GAS_LIMIT_MINT,
      nonce: await getNextNonce(provider, wallet.address)
    });
    const receipt = await tx.wait();
    if (receipt.status === 0) throw new Error("Add LP reverted");
    return { success: true, txHash: tx.hash, amountSYN: amountSYN };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
}

async function runCycle() {
  logHeader();
  console.log(chalk.green(`Loaded ${privateKeys.length} wallets from privatekey.txt`));
  console.log(chalk.green(`Loaded ${proxies.length} proxies from proxy.txt (optional)\n`));

  console.log(chalk.yellow("⚙️  Config:"));
  console.log(`   ▸ Swap per wallet   : ${SWAPS_PER_WALLET} kali`);
  console.log(`   ▸ UOMI swap amount  : ${UOMI_SWAP_MIN} – ${UOMI_SWAP_MAX}`);
  console.log(`   ▸ WUOMI LP amount   : ${WUOMI_LP_MIN} – ${WUOMI_LP_MAX}`);
  console.log(`   ▸ Delay antar swap  : ${DELAY_SWAP_MIN/1000}-${DELAY_SWAP_MAX/1000} detik`);
  console.log(`   ▸ Delay antar siklus: ${DELAY_CYCLE_MIN/3600000}-${DELAY_CYCLE_MAX/3600000} jam\n`);

  while (true) {
    console.log(chalk.yellow("\n⏳ Memulai siklus baru..."));

    for (let i = 0; i < privateKeys.length; i++) {
      const pk = privateKeys[i];
      const proxy = proxies.length > 0 ? proxies[i % proxies.length] : null;
      console.log(chalk.blueBright(`\n[Wallet ${i + 1}] Loading wallet (proxy: ${proxy || "none"})`));

      let provider;
      try {
        provider = getProviderWithAgent(proxy);
        await provider.getNetwork();
      } catch (err) {
        console.log(chalk.red(`  ❌ Provider connection failed for wallet ${i + 1}: ${err.message}`));
        continue;
      }

      let wallet;
      try {
        wallet = new ethers.Wallet(pk, provider);
        console.log(chalk.gray(`  ▸ Address: ${wallet.address}`));
      } catch (err) {
        console.log(chalk.red(`  ❌ Invalid private key for wallet ${i + 1}: ${err.message}`));
        continue;
      }

      for (let s = 1; s <= SWAPS_PER_WALLET; s++) {
        const amount = randomInRange(UOMI_SWAP_MIN, UOMI_SWAP_MAX, 4);
        process.stdout.write(chalk.white(`  ➜ Swap ${s}/${SWAPS_PER_WALLET}: ${amount} UOMI ➜ SYN ... `));
        try {
          const res = await performSwap(wallet, amount);
          if (res.success) {
            console.log(chalk.green(`✅ (Tx: ${res.txHash})`));
          } else {
            console.log(chalk.red(`❌ ${res.error}`));
          }
        } catch (err) {
          console.log(chalk.red(`❌ ${err.message || err}`));
        }

        if (s < SWAPS_PER_WALLET) {
          const waitMs = Math.floor(Math.random() * (DELAY_SWAP_MAX - DELAY_SWAP_MIN) + DELAY_SWAP_MIN);
          console.log(chalk.gray(`    ⏳ Menunggu ${Math.round(waitMs/1000)} detik sebelum swap berikutnya...`));
          await sleep(waitMs);
        }
      }

      const amountWUOMI = randomInRange(WUOMI_LP_MIN, WUOMI_LP_MAX, 4);
      process.stdout.write(chalk.white(`  ➜ Add LP: ${amountWUOMI} WUOMI + SYN ... `));
      try {
        const resLP = await performAddLp(wallet, amountWUOMI);
        if (resLP.success) {
          console.log(chalk.green(`✅ (Tx: ${resLP.txHash})`));
        } else {
          console.log(chalk.red(`❌ ${resLP.error}`));
        }
      } catch (err) {
        console.log(chalk.red(`❌ ${err.message || err}`));
      }

      console.log(chalk.gray("  ⏳ Pindah ke wallet berikutnya..."));
      await sleep(2000);
    }

    const delayCycle = Math.floor(Math.random() * (DELAY_CYCLE_MAX - DELAY_CYCLE_MIN) + DELAY_CYCLE_MIN);
    const mins = Math.round(delayCycle / 60000);
    console.log(chalk.green(`\n💤 Semua wallet selesai. Menunggu ${mins} menit sebelum siklus berikutnya...\n`));
    await sleep(delayCycle);
  }
}

runCycle().catch((err) => {
  console.error(chalk.red("Fatal error:"), err);
  process.exit(1);
});

