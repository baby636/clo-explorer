/*
Name: Ethereum Blockchain syncer
Version: .0.0.2
This file will start syncing the blockchain from the node address you provide in the conf.json file.
Please read the README in the root directory that explains the parameters of this code
*/
require('../db.js');
var etherUnits = require("../lib/etherUnits.js");
var BigNumber = require('bignumber.js');
var _ = require('lodash');

var asyncL = require('async');

var Web3 = require('web3');

var mongoose = require('mongoose');
var Block = mongoose.model('Block');
var Transaction = mongoose.model('Transaction');
var Account = mongoose.model('Account');

const normalizeTX = async(txData, blockData) => {
    var tx = {
        blockHash: txData.blockHash,
        blockNumber: txData.blockNumber,
        from: txData.from.toLowerCase(),
        to: txData.to.toLowerCase(),
        hash: txData.hash,
        value: etherUnits.toEther(new BigNumber(txData.value), 'wei'),
        nonce: txData.nonce,
        r: txData.r,
        s: txData.s,
        v: txData.v,
        gas: txData.gas,
        gasUsed: 0,
        gasPrice: txData.gasPrice,
        input: txData.input,
        transactionIndex: txData.transactionIndex,
        timestamp: blockData.timestamp,
        status: 0
    };
    // getTransactionReceipt to get contract address and more data

    let receipt;
    try {
        receipt = await web3.eth.getTransactionReceipt(tx.hash)
    } catch (err) {
        console.log('Error', err);
    }
    tx.gasUsed = receipt.gasUsed;
    tx.status = receipt.status;

    if (txData.to == null) {
        // parity support `creates` field
        if (txData.creates) {
            tx.creates = txData.creates;
            return tx;
        } else {
            if (receipt && receipt.contractAddress) {
                tx.creates = receipt.contractAddress;
            }
            return tx;
        }
    } else {
        return tx;
    }
}

/**
  //Just listen for latest blocks and sync from the start of the app.
**/
var listenBlocks = function(config) {
        var newBlocks = web3.eth.subscribe('newBlockHeaders', function(error, result) {
            if (!error) {
                return;
            }

            console.error(error);
        });
        newBlocks.on("data", function(blockHeader) {
            web3.eth.getBlock(blockHeader.hash, true, function(error, blockData) {
                if (blockHeader == null) {
                    console.log('Warning: null block hash');
                } else {
                    writeBlockToDB(config, blockData, true);
                    writeTransactionsToDB(config, blockData, true);
                }
            });
        });
        newBlocks.on("error", console.error);
    }
    /**
      If full sync is checked this function will start syncing the block chain from lastSynced param see README
    **/
var syncChain = function(config, nextBlock) {
        if (web3.eth.net.isListening()) {
            if (typeof nextBlock === 'undefined') {
                prepareSync(config, function(error, startBlock) {
                    if (error) {
                        console.log('ERROR: error: ' + error);
                        return;
                    }
                    syncChain(config, startBlock);
                });
                return;
            }

            if (nextBlock == null) {
                console.log('nextBlock is null');
                return;
            } else if (nextBlock < config.startBlock) {
                writeBlockToDB(config, null, true);
                writeTransactionsToDB(config, null, true);
                console.log('*** Sync Finsihed ***');
                config.syncAll = false;
                return;
            }

            var count = config.bulkSize;
            while (nextBlock >= config.startBlock && count > 0) {
                web3.eth.getBlock(nextBlock, true, function(error, blockData) {
                    if (error) {
                        console.log('Warning (syncChain): error on getting block with hash/number: ' + nextBlock + ': ' + error);
                    } else if (blockData == null) {
                        console.log('Warning: null block data received from the block with hash/number: ' + nextBlock);
                    } else {
                        writeBlockToDB(config, blockData);
                        writeTransactionsToDB(config, blockData);
                    }
                });
                nextBlock--;
                count--;
            }

            setTimeout(function() { syncChain(config, nextBlock); }, 500);
        } else {
            console.log('Error: Web3 connection time out trying to get block ' + nextBlock + ' retrying connection now');
            syncChain(config, nextBlock);
        }
    }
    /**
      Write the whole block object to DB
    **/
var writeBlockToDB = function(config, blockData, flush) {
        var self = writeBlockToDB;
        if (!self.bulkOps) {
            self.bulkOps = [];
        }
        if (blockData && blockData.number >= 0) {
            self.bulkOps.push(new Block(blockData));
            console.log('\t- block #' + blockData.number.toString() + ' inserted.');
        }

        if (flush && self.bulkOps.length > 0 || self.bulkOps.length >= config.bulkSize) {
            var bulk = self.bulkOps;
            self.bulkOps = [];
            if (bulk.length == 0) return;

            Block.collection.insert(bulk, function(err, blocks) {
                if (typeof err !== 'undefined' && err) {
                    if (err.code == 11000) {
                        if (!('quiet' in config && config.quiet === true)) {
                            console.log('Skip: Duplicate DB key : ' + err);
                        }
                    } else {
                        console.log('Error: Aborted due to error on DB: ' + err);
                        process.exit(9);
                    }
                } else {
                    console.log('* ' + blocks.insertedCount + ' blocks successfully written.');
                }
            });
        }
    }
    /**
      Break transactions out of blocks and write to DB
    **/
const writeTransactionsToDB = async(config, blockData, flush) => {
        var self = writeTransactionsToDB;
        if (!self.bulkOps) {
            self.bulkOps = [];
            self.blocks = 0;
        }
        // save miner addresses
        if (!self.miners) {
            self.miners = [];
        }
        if (blockData) {
            self.miners.push({ address: blockData.miner, blockNumber: blockData.blockNumber, type: 0 });
        }
        if (blockData && blockData.transactions.length > 0) {
            for (d in blockData.transactions) {
                var txData = blockData.transactions[d];

                var tx = await normalizeTX(txData, blockData);
                self.bulkOps.push(tx);
            }
            console.log('\t- block #' + blockData.number.toString() + ': ' + blockData.transactions.length.toString() + ' transactions recorded.');
        }
        self.blocks++;

        if (flush && self.blocks > 0 || self.blocks >= config.bulkSize) {
            var bulk = self.bulkOps;
            self.bulkOps = [];
            self.blocks = 0;
            var miners = self.miners;
            self.miners = [];

            // setup accounts
            var data = {};
            bulk.forEach(function(tx) {
                data[tx.from] = { address: tx.from, blockNumber: tx.blockNumber, type: 0 };
                if (tx.to) {
                    data[tx.to] = { address: tx.to, blockNumber: tx.blockNumber, type: 0 };
                }
            });

            // setup miners
            miners.forEach(function(miner) {
                data[miner.address] = miner;
            });

            var accounts = Object.keys(data);

            if (bulk.length == 0 && accounts.length == 0) return;

            // update balances
            if (accounts.length > 0)
                asyncL.eachSeries(accounts, function(account, eachCallback) {
                    var blockNumber = data[account].blockNumber;
                    // get contract account type
                    web3.eth.getCode(account, function(err, code) {
                        if (err) {
                            console.log("ERROR: fail to getCode(" + account + ")");
                            return eachCallback(err);
                        }
                        if (code.length > 2) {
                            data[account].type = 1; // contract type
                        }

                        web3.eth.getBalance(account, blockNumber, function(err, balance) {
                            if (err) {
                                console.log(err);
                                console.log("ERROR: fail to getBalance(" + account + ")");
                                return eachCallback(err);
                            }

                            data[account].balance = parseFloat(web3.utils.fromWei(balance, 'ether'));

                            // let ether;
                            //
                            // if (typeof balance === 'object') {
                            //   ether = parseFloat(balance.div(1e18).toString());
                            // } else {
                            //   ether /= 1e18;
                            // }
                            // data[account].balance = ether;
                            eachCallback();
                        });
                    });
                }, function(err) {
                    var n = 0;
                    accounts.forEach(function(account) {
                        n++;
                        if (n <= 5) {
                            console.log(' - upsert ' + account + ' / balance = ' + data[account].balance);
                        } else if (n == 6) {
                            console.log('   (...) total ' + accounts.length + ' accounts updated.');
                        }
                        // upsert account
                        Account.collection.update({ address: account }, { $set: data[account] }, { upsert: true });
                    });
                });

            if (bulk.length > 0)
                Transaction.collection.insert(bulk, function(err, tx) {
                    if (typeof err !== 'undefined' && err) {
                        if (err.code == 11000) {
                            if (!('quiet' in config && config.quiet === true)) {
                                console.log('Skip: Duplicate transaction key ' + err);
                            }
                        } else {
                            console.log('Error: Aborted due to error on Transaction: ' + err);
                            process.exit(9);
                        }
                    } else {
                        console.log('* ' + tx.insertedCount + ' transactions successfully recorded.');
                    }
                });
        }
    }
    /**
      //check oldest block or starting block then callback
    **/
const prepareSync = async(config, callback) => {
        var blockNumber = null;
        var oldBlockFind = Block.find({}, "number").lean(true).sort('number').limit(1);
        oldBlockFind.exec(async(err, docs) => {
            if (err || !docs || docs.length < 1) {
                // not found in db. sync from config.endBlock or 'latest'
                if (web3.eth.net.isListening()) {
                    var currentBlock = await web3.eth.getBlockNumber();
                    var latestBlock = config.endBlock || currentBlock || 'latest';
                    if (latestBlock === 'latest') {
                        web3.eth.getBlock(latestBlock, true, function(error, blockData) {
                            if (error) {
                                console.log('Warning (prepareSync): error on getting block with hash/number: ' + latestBlock + ': ' + error);
                            } else if (blockData == null) {
                                console.log('Warning: null block data received from the block with hash/number: ' + latestBlock);
                            } else {
                                console.log('Starting block number = ' + blockData.number);
                                blockNumber = blockData.number - 1;
                                callback(null, blockNumber);
                            }
                        });
                    } else {
                        console.log('Starting block number = ' + latestBlock);
                        blockNumber = latestBlock - 1;
                        callback(null, blockNumber);
                    }
                } else {
                    console.log('Error: Web3 connection error');
                    callback(err, null);
                }
            } else {
                blockNumber = docs[0].number - 1;
                console.log('Old block found. Starting block number = ' + blockNumber);
                callback(null, blockNumber);
            }
        });
    }
    /**
      Block Patcher(experimental)
    **/
const runPatcher = async(config, startBlock, endBlock) => {
        if (!web3 || !web3.eth.net.isListening()) {
            console.log('Error: Web3 is not connected. Retrying connection shortly...');
            setTimeout(function() { runPatcher(config); }, 3000);
            return;
        }

        if (typeof startBlock === 'undefined' || typeof endBlock === 'undefined') {
            // get the last saved block
            var blockFind = Block.find({}, "number").lean(true).sort('-number').limit(1);
            blockFind.exec(async(err, docs) => {
                if (err || !docs || docs.length < 1) {
                    // no blocks found. terminate runPatcher()
                    console.log('No need to patch blocks.');
                    return;
                }

                var lastMissingBlock = docs[0].number + 1;
                var currentBlock = await web3.eth.getBlockNumber();
                runPatcher(config, currentBlock - 1000, currentBlock - 1);
            });
            return;
        }

        var missingBlocks = endBlock - startBlock + 1;
        if (missingBlocks > 0) {
            console.log('Patching from #' + startBlock + ' to #' + endBlock);
            var patchBlock = startBlock;
            var count = 0;
            while (count < config.patchBlocks && patchBlock <= endBlock) {
                if (!('quiet' in config && config.quiet === true)) {
                    console.log('Patching Block: ' + patchBlock)
                }
                web3.eth.getBlock(patchBlock, true, function(error, patchData) {
                    if (error) {
                        console.log('Warning: error on getting block with hash/number: ' + patchBlock + ': ' + error);
                    } else if (patchData == null) {
                        console.log('Warning: null block data received from the block with hash/number: ' + patchBlock);
                    } else {
                        checkBlockDBExistsThenWrite(config, patchData)
                    }
                });
                patchBlock++;
                count++;
            }
            // flush
            writeBlockToDB(config, null, true);
            writeTransactionsToDB(config, null, true);

            setTimeout(function() { runPatcher(config, patchBlock, endBlock); }, 1000);
        } else {
            // flush
            writeBlockToDB(config, null, true);
            writeTransactionsToDB(config, null, true);
            currentBlock = await web3.eth.getBlockNumber();
            setTimeout(function() { runPatcher(config, currentBlock - 1000, currentBlock); }, 600000);
            console.log('*** Block Patching Completed ***');
        }
    }
    /**
      This will be used for the patcher(experimental)
    **/
var checkBlockDBExistsThenWrite = function(config, patchData, flush) {
    Block.find({ number: patchData.number }, function(err, b) {
        if (!b.length) {
            writeBlockToDB(config, patchData, flush);
            writeTransactionsToDB(config, patchData, flush);
        } else if (!('quiet' in config && config.quiet === true)) {
            console.log('Block number: ' + patchData.number.toString() + ' already exists in DB.');
        }
    });
};
/**
  Start config for node connection and sync
**/
/**
 * nodeAddr: node address
 * gethPort: geth port
 * bulkSize: size of array in block to use bulk operation
 */
// load config.json
var config = { nodeAddr: 'localhost', gethPort: 8545, bulkSize: 100 };
try {
    var local = require('../config.json');
    _.extend(config, local);
    console.log('config.json found.');
} catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
        var local = require('../config.example.json');
        _.extend(config, local);
        console.log('No config file found. Using default configuration... (config.example.json)');
    } else {
        throw error;
        process.exit(1);
    }
}

console.log('Connecting ' + config.nodeAddr + ':' + config.gethPort + '...');

// Sets address for RPC WEB3 to connect to, usually your node IP address defaults ot localhost
//var web3 = new Web3(new Web3.providers.HttpProvider('http://' + config.nodeAddr + ':' + config.gethPort.toString()));
var web3 = new Web3(new Web3.providers.WebsocketProvider('ws://' + config.nodeAddr + ':' + config.wsPort));

// patch missing blocks
if (config.patch === true) {
    console.log('Checking for missing blocks');
    runPatcher(config);
}

// Start listening for latest blocks
listenBlocks(config);

// Starts full sync when set to true in config
if (config.syncAll === true) {
    console.log('Starting Full Sync');
    syncChain(config);
}