import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { findProgramAddressSync } from "@project-serum/anchor/dist/cjs/utils/pubkey";
import {
  MAX_FEE_BASIS_POINTS,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import { BankrunProvider } from "anchor-bankrun";
import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { beforeEach } from "mocha";
import { BanksClient, ProgramTestContext, startAnchor } from "solana-bankrun";

import { BN, BigNumber } from "../../constants";
import {
  createMockOwnerConfig,
  createMockpoolConfig,
  getAccountBalance,
  getAllAccountState,
  setup,
  skipBlockTimestamp,
} from "../../helpers";
import { FjordLbp, IDL } from "../../target/types/fjord_lbp";

chai.use(chaiAsPromised);

describe("Fjord LBP - Sell", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());
  const lbpProgramId = (anchor.workspace.FjordLbp as Program<FjordLbp>)
    .programId;

  let creator: Keypair;
  let testUserA: Keypair;

  let shareTokenMint: PublicKey; // project token address
  let assetTokenMint: PublicKey; // collateral token address

  let assetTokenMintUserAccount: PublicKey | undefined;
  let shareTokenMintUserAccount: PublicKey | undefined;

  // Address of the deployed pool
  let poolPda: PublicKey;

  // A fixed account that holds the owner configuration of all the pools (e.g. fees)
  let ownerConfigPda: PublicKey;
  const treasuryPda: PublicKey = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    lbpProgramId
  )[0];

  // Pool accounts that store the tokens
  let poolShareTokenAccount: PublicKey;
  let poolAssetTokenAccount: PublicKey;

  // creator accounts that holds the tokens
  let creatorShareTokenAccount: PublicKey;
  let creatorAssetTokenAccount: PublicKey;

  let initialProjectTokenBalanceCreator: BigNumber;
  let initialCollateralTokenBalanceCreator: BigNumber;

  // Misc
  let program: Program<FjordLbp> = anchor.workspace
    .FjordLbp as Program<FjordLbp>;
  let { connection } = program.provider;
  let bankRunClient: BanksClient;
  let bankRunCtx: ProgramTestContext;

  beforeEach(async () => {
    // Setup
    testUserA = Keypair.generate();
    creator = anchor.workspace.FjordLbp.provider.wallet.payer;
    program = anchor.workspace.FjordLbp as Program<FjordLbp>;
    connection = program.provider.connection;

    // Setup owner configurations. This includes global pool fees, etc...
    const ownerConfig = createMockOwnerConfig();
    const [programDataAddress] = findProgramAddressSync(
      [program.programId.toBytes()],
      new anchor.web3.PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")
    );

    try {
      // Initialize global pool settings
      const tx = program.methods
        .initializeOwnerConfig(...(Object.values(ownerConfig) as any))
        .accounts({
          program: program.programId,
          programData: programDataAddress,
          authority: creator.publicKey,
        })
        .signers([creator]);

      const pubkeys = await tx.pubkeys();
      ownerConfigPda = pubkeys.config as PublicKey;
      await tx.rpc();
    } catch {
      // Do nothing
    }

    // Setup bankrun client [HACKY]
    // Bankrun runs a fresh instance of the network which doesn't come with a valid program_data account that's needed in initializeOwnerConfig().
    // So we must first start the anchor with our program, then initialize the owner config, then start the bankrun client with the ported over account.
    const ownerConfigAcc = await connection.getAccountInfo(ownerConfigPda);
    const treasuryAcc = await connection.getAccountInfo(treasuryPda);

    bankRunCtx = await startAnchor(
      "",
      [],
      [
        {
          address: ownerConfigPda,
          info: ownerConfigAcc!,
        },
        {
          address: treasuryPda,
          info: treasuryAcc!,
        },
      ]
    );
    const provider = new BankrunProvider(bankRunCtx);
    bankRunClient = bankRunCtx.banksClient;

    program = new Program<FjordLbp>(IDL, lbpProgramId, provider);
    connection = provider.connection;
    creator = bankRunCtx.payer;

    // Transfer some sol to testUserA from creator for fees
    const transferTx = new Transaction();
    transferTx.recentBlockhash = bankRunCtx.lastBlockhash;
    transferTx.feePayer = creator.publicKey;
    transferTx.add(
      SystemProgram.transfer({
        fromPubkey: creator.publicKey,
        toPubkey: testUserA.publicKey,
        lamports: 5 * LAMPORTS_PER_SOL,
      })
    );
    transferTx.sign(creator);
    await bankRunClient.processTransaction(transferTx);

    ({
      tokenAMint: shareTokenMint,
      tokenBMint: assetTokenMint,
      tokenAMintPayerAccount: creatorShareTokenAccount,
      tokenBMintPayerAccount: creatorAssetTokenAccount,
      tokenAUserAccount: shareTokenMintUserAccount,
      tokenBUserAccount: assetTokenMintUserAccount,
    } = await setup({
      payer: creator,
      connection,
      testUser: testUserA,
      bankRunClient,
    }));

    // get token balance
    initialProjectTokenBalanceCreator = await getAccountBalance(
      bankRunCtx.banksClient,
      creator.publicKey,
      shareTokenMint
    );

    initialCollateralTokenBalanceCreator = await getAccountBalance(
      bankRunCtx.banksClient,
      creator.publicKey,
      assetTokenMint
    );

    // Get pool address
    [poolPda] = findProgramAddressSync(
      [
        shareTokenMint.toBuffer(),
        assetTokenMint.toBuffer(),
        creator.publicKey.toBuffer(),
      ],
      program.programId
    );

    // Pre-compute the account addresses
    // These will store the pool's tokens
    poolShareTokenAccount = await getAssociatedTokenAddress(
      shareTokenMint,
      poolPda,
      true
    );
    poolAssetTokenAccount = await getAssociatedTokenAddress(
      assetTokenMint,
      poolPda,
      true
    );
  });

  describe("Success case", async () => {
    beforeEach(async () => {
      const sharesAmount = initialProjectTokenBalanceCreator;
      const assetsAmount = initialCollateralTokenBalanceCreator;

      const poolParams = createMockpoolConfig({
        assets: assetsAmount,
        shares: sharesAmount,
        maxSharePrice: BN("1000000000000000000"),
        maxAssetsIn: BN("1000000000000000000"),
        maxSharesOut: BN("1000000000000000000"),
        sellingAllowed: true,
      });

      const formattedPoolParams = Object.values(poolParams) as any;

      await program.methods
        .initializePool(...formattedPoolParams)
        .accounts({
          creator: creator.publicKey,
          shareTokenMint,
          assetTokenMint,
          poolShareTokenAccount,
          poolAssetTokenAccount,
          creatorShareTokenAccount,
          creatorAssetTokenAccount,
        })
        .signers([creator])
        .rpc();

      // Skip time by 1100 seconds
      await skipBlockTimestamp(bankRunCtx, 1100);

      const initialUserCollateralTokenBalance = await getAccountBalance(
        bankRunClient,
        testUserA.publicKey,
        assetTokenMint
      );

      // Get user's pool account
      const userPoolPda = findProgramAddressSync(
        [testUserA.publicKey.toBuffer(), poolPda.toBuffer()],
        program.programId
      )[0];

      const assetAmountIn = initialUserCollateralTokenBalance.div(BN(2));

      // Get expected shares out by reading a view function's emitted event.
      const expectedSharesOut = await program.methods
        .previewSharesOut(
          // Assets In (Collateral)
          assetAmountIn
        )
        .accounts({
          assetTokenMint,
          shareTokenMint,
          pool: poolPda,
          poolAssetTokenAccount,
          poolShareTokenAccount,
        })
        .signers([creator])
        .simulate()
        .then((data) => data.events[0].data.sharesOut as BigNumber);

      // Buy project token
      await program.methods
        .swapExactAssetsForShares(assetAmountIn, expectedSharesOut, null, null)
        .accounts({
          assetTokenMint,
          shareTokenMint,
          user: testUserA.publicKey,
          pool: poolPda,
          poolAssetTokenAccount,
          poolShareTokenAccount,
          userAssetTokenAccount: assetTokenMintUserAccount,
          userShareTokenAccount: shareTokenMintUserAccount,
          config: ownerConfigPda,
          referrerStateInPool: null,
          userStateInPool: userPoolPda,
        })
        .signers([testUserA])
        .rpc();
    });
    it("should be able to sell exact project tokens (shares) for collateral tokens (assets)", async () => {
      const {
        userAssetBalance: userAssetBalanceBefore,
        poolAssetBalance: poolAssetBalanceBefore,
        userPoolPda,
        userPoolAccount: userPoolAccountBefore,
        pool: poolBefore,
      } = await getAllAccountState({
        program,
        poolPda,
        bankRunClient,
        shareTokenMint,
        assetTokenMint,
        user: testUserA.publicKey,
        ownerConfigPda,
        creator: creator.publicKey,
      });

      // Number of project tokens to sell (Shares)
      const sharesIn = userPoolAccountBefore?.purchasedShares.div(BN(2))!;

      const minAssetsOut = await program.methods
        .previewAssetsOut(
          // Shares to sell (Collateral)
          sharesIn
        )
        .accounts({
          assetTokenMint,
          shareTokenMint,
          pool: poolPda,
          poolAssetTokenAccount,
          poolShareTokenAccount,
        })
        .signers([creator])
        .simulate()
        .then((data) => data.events[0].data.assetsOut as BigNumber);

      // Sell project token
      await program.methods
        .swapExactSharesForAssets(sharesIn, minAssetsOut, null, null)
        .accounts({
          assetTokenMint,
          shareTokenMint,
          user: testUserA.publicKey,
          pool: poolPda,
          poolAssetTokenAccount,
          poolShareTokenAccount,
          userAssetTokenAccount: assetTokenMintUserAccount,
          userShareTokenAccount: shareTokenMintUserAccount,
          config: ownerConfigPda,
          referrerStateInPool: null,
          userStateInPool: userPoolPda,
        })
        .signers([testUserA])
        .rpc();

      const {
        userPoolAccount: userPoolAccountAfter,
        userAssetBalance: userAssetBalanceAfter,
        poolAssetBalance: poolAssetBalanceAfter,
        pool: poolAfter,
        ownerConfig: { swapFee },
      } = await getAllAccountState({
        program,
        poolPda,
        bankRunClient,
        shareTokenMint,
        assetTokenMint,
        user: testUserA.publicKey,
        ownerConfigPda,
        creator: creator.publicKey,
      });

      expect(userPoolAccountAfter?.purchasedShares.toString()).to.eq(
        userPoolAccountBefore?.purchasedShares.sub(sharesIn).toString()
      );
      expect(userAssetBalanceAfter.toString()).to.eq(
        userAssetBalanceBefore.add(minAssetsOut).toString()
      );
      expect(poolAfter.totalSwapFeesShare.toString()).to.eq(
        poolBefore.totalSwapFeesShare
          .add(sharesIn.mul(BN(swapFee)).div(BN(MAX_FEE_BASIS_POINTS)))
          .toString()
      );
      expect(poolAfter.totalPurchased.toString()).to.eq(
        poolBefore.totalPurchased.sub(sharesIn).toString()
      );
      expect(poolAssetBalanceAfter.toString()).to.eq(
        poolAssetBalanceBefore.sub(minAssetsOut).toString()
      );
    });

    it("should be able to sell project token (shares) for exact collateral tokens (assets)", async () => {
      const {
        userAssetBalance: userAssetBalanceBefore,
        poolAssetBalance: poolAssetBalanceBefore,
        userPoolPda,
        userPoolAccount: userPoolAccountBefore,
        pool: poolBefore,
      } = await getAllAccountState({
        program,
        poolPda,
        bankRunClient,
        shareTokenMint,
        assetTokenMint,
        user: testUserA.publicKey,
        ownerConfigPda,
        creator: creator.publicKey,
      });

      const assetsToSell = BN("100000000");

      const maxSharesIn = await program.methods
        .previewSharesIn(
          // Assets to sell (Collateral)
          assetsToSell
        )
        .accounts({
          assetTokenMint,
          shareTokenMint,
          pool: poolPda,
          poolAssetTokenAccount,
          poolShareTokenAccount,
        })
        .signers([creator])
        .simulate()
        .then((data) => data.events[0].data.sharesIn as BigNumber);

      // Sell project token
      await program.methods
        .swapSharesForExactAssets(assetsToSell, maxSharesIn, null, null)
        .accounts({
          assetTokenMint,
          shareTokenMint,
          user: testUserA.publicKey,
          pool: poolPda,
          poolAssetTokenAccount,
          poolShareTokenAccount,
          userAssetTokenAccount: assetTokenMintUserAccount,
          userShareTokenAccount: shareTokenMintUserAccount,
          config: ownerConfigPda,
          referrerStateInPool: null,
          userStateInPool: userPoolPda,
        })
        .signers([testUserA])
        .rpc();

      const {
        userPoolAccount: userPoolAccountAfter,
        userAssetBalance: userAssetBalanceAfter,
        poolAssetBalance: poolAssetBalanceAfter,
        pool: poolAfter,
        ownerConfig: { swapFee },
      } = await getAllAccountState({
        program,
        poolPda,
        bankRunClient,
        shareTokenMint,
        assetTokenMint,
        user: testUserA.publicKey,
        ownerConfigPda,
        creator: creator.publicKey,
      });

      expect(userPoolAccountAfter?.purchasedShares.toString()).to.eq(
        userPoolAccountBefore?.purchasedShares.sub(maxSharesIn).toString()
      );
      expect(userAssetBalanceAfter.toString()).to.eq(
        userAssetBalanceBefore.add(assetsToSell).toString()
      );

      expect(poolAfter.totalSwapFeesShare.toNumber()).to.be.closeTo(
        poolBefore.totalSwapFeesShare
          .add(maxSharesIn.mul(BN(swapFee)).div(BN(MAX_FEE_BASIS_POINTS)))
          .toNumber(),
        120000 // 0.99% error margin
      );
      expect(poolAfter.totalPurchased.toString()).to.eq(
        poolBefore.totalPurchased.sub(maxSharesIn).toString()
      );
      expect(poolAssetBalanceAfter.toString()).to.eq(
        poolAssetBalanceBefore.sub(assetsToSell).toString()
      );
    });
  });

  describe("Failure case", async () => {
    beforeEach(async () => {
      const sharesAmount = initialProjectTokenBalanceCreator;
      const assetsAmount = initialCollateralTokenBalanceCreator;

      const poolParams = createMockpoolConfig({
        assets: assetsAmount,
        shares: sharesAmount,
        maxSharePrice: BN("1000000000000000000"),
        maxAssetsIn: BN("1000000000000000000"),
        maxSharesOut: BN("1000000000000000000"),
        sellingAllowed: false,
      });

      const formattedPoolParams = Object.values(poolParams) as any;

      await program.methods
        .initializePool(...formattedPoolParams)
        .accounts({
          creator: creator.publicKey,
          shareTokenMint,
          assetTokenMint,
          poolShareTokenAccount,
          poolAssetTokenAccount,
          creatorShareTokenAccount,
          creatorAssetTokenAccount,
        })
        .signers([creator])
        .rpc();

      // Skip time by 1100 seconds
      await skipBlockTimestamp(bankRunCtx, 1100);

      const initialUserCollateralTokenBalance = await getAccountBalance(
        bankRunClient,
        testUserA.publicKey,
        assetTokenMint
      );

      // Get user's pool account
      const userPoolPda = findProgramAddressSync(
        [testUserA.publicKey.toBuffer(), poolPda.toBuffer()],
        program.programId
      )[0];

      const assetAmountIn = initialUserCollateralTokenBalance.div(BN(2));

      // Get expected shares out by reading a view function's emitted event.
      const expectedSharesOut = await program.methods
        .previewSharesOut(
          // Assets In (Collateral)
          assetAmountIn
        )
        .accounts({
          assetTokenMint,
          shareTokenMint,
          pool: poolPda,
          poolAssetTokenAccount,
          poolShareTokenAccount,
        })
        .signers([creator])
        .simulate()
        .then((data) => data.events[0].data.sharesOut as BigNumber);

      // Buy some project tokens
      await program.methods
        .swapExactAssetsForShares(assetAmountIn, expectedSharesOut, null, null)
        .accounts({
          assetTokenMint,
          shareTokenMint,
          user: testUserA.publicKey,
          pool: poolPda,
          poolAssetTokenAccount,
          poolShareTokenAccount,
          userAssetTokenAccount: assetTokenMintUserAccount,
          userShareTokenAccount: shareTokenMintUserAccount,
          config: ownerConfigPda,
          referrerStateInPool: null,
          userStateInPool: userPoolPda,
        })
        .signers([testUserA])
        .rpc();
    });
    it("Should not be able to sell when selling is disallowed", async () => {
      const pool = await program.account.liquidityBootstrappingPool.fetch(
        poolPda
      );
      expect(pool.sellingAllowed).to.eq(false);

      await expect(
        program.methods
          .swapExactSharesForAssets(BN(1), BN(1), null, null)
          .accounts({
            assetTokenMint,
            shareTokenMint,
            user: testUserA.publicKey,
            pool: poolPda,
            poolAssetTokenAccount,
            poolShareTokenAccount,
            userAssetTokenAccount: assetTokenMintUserAccount,
            userShareTokenAccount: shareTokenMintUserAccount,
            config: ownerConfigPda,
            referrerStateInPool: null,
          })
          .signers([testUserA])
          .rpc()
      ).to.be.rejectedWith("SellingDisallowed");
    });
    it("Should not be able to sell when the sale is over", async () => {
      const pool = await program.account.liquidityBootstrappingPool.fetch(
        poolPda
      );
      // Skip time by 1100 seconds
      await skipBlockTimestamp(bankRunCtx, pool.saleEndTime.toNumber() + 1);

      await expect(
        program.methods
          .swapExactSharesForAssets(BN(1), BN(1), null, null)
          .accounts({
            assetTokenMint,
            shareTokenMint,
            user: testUserA.publicKey,
            pool: poolPda,
            poolAssetTokenAccount,
            poolShareTokenAccount,
            userAssetTokenAccount: assetTokenMintUserAccount,
            userShareTokenAccount: shareTokenMintUserAccount,
            config: ownerConfigPda,
            referrerStateInPool: null,
          })
          .signers([testUserA])
          .rpc()
      ).to.be.rejectedWith("TradingDisallowed");
    });
  });
});
