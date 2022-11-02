const { GraphQLClient, gql } = require('graphql-request')
const fs = require('fs');
require('dotenv').config();

const BITQUERY_ENDPOINT = 'https://graphql.bitquery.io/'
const bitqueryApiKey = process.env.BITQUERY_API_KEY
const dexRouterAddress = process.env.DEX_ROUTER_ADDRESS
const wrappedCoinAddress = process.env.WRAPPED_COIN_ADDRESS
const blockCount = 10
const network = process.env.DEX_NETWORK

const graphQLClient = new GraphQLClient(BITQUERY_ENDPOINT, {
    headers: {
        'X-API-KEY': bitqueryApiKey,
    }
})

const getLatestBlock = async () => {
    console.log('\n<<<<<<<<<<<<------- Getting latest block ------->>>>>>>>>>>>')

    const query = gql`
        query{
            ethereum{
                blocks{
                    count
                }
            }
        }
    `
    const data = await graphQLClient.request(query)
    const blockNumber = data.ethereum.blocks[0].count
    console.log('last block: ', blockNumber)
    return blockNumber;
}

const getSmartContractEventDataByHash = async (hash) => {
    const eventQuery = gql`
        query ($network: EthereumNetwork!, $hash: String!) {
            ethereum(network: $network) {
                smartContractEvents(txHash: {is: $hash}, smartContractEvent: {in: ["Burn", "Withdrawal"]}) {
                    smartContractEvent {
                        name
                    }
                    arguments {
                        argument
                        value
                    }
                }
            }
        }
    `
    const variables = { network, hash }
    const eventData = await graphQLClient.request(eventQuery, variables)

    return eventData;
}

const getTransactionData = async (blockNumber) => {
    console.log('\n<<<<<<<<<<<<------- Getting transactions ------->>>>>>>>>>>>')
    const transactionQuery = gql`
        query ($network: EthereumNetwork!, $address: String!, $limit: Int!, $offset: Int!, $from: Int!, $to: Int!, $methods: [String!]!) {
            ethereum(network: $network) {
                smartContractCalls(
                    options: {desc: "block.timestamp.unixtime", limit: $limit, offset: $offset}
                    smartContractAddress: {is: $address}
                    height: {lt: $to, gteq: $from}
                    smartContractMethod: {in: $methods}
                ) {
                    block {
                        timestamp {
                            unixtime
                        }
                        height
                    }
                    smartContractMethod {
                        name
                    }
                    transaction {
                        hash
                    }
                    external(external: true)
                    arguments {
                        value
                        argumentType
                    }
                    caller {
                        address
                    }
                }
            }
        }
    `
    const stepCount = 50;
    const methods = [
        "removeLiquidityWithPermit",
        "removeLiquidityETH",
        "removeLiquidityETHWithPermit",
        "removeLiquidityETHWithPermitSupportingFeeOnTransferTokens"
    ]
    let transactions = [];
    let isEnded = false;
    let i = 0;
    while (!isEnded) {
        const variables = {
            limit: stepCount,
            offset: i * stepCount,
            network,
            address: dexRouterAddress,
            methods,
            from: blockNumber - blockCount,
            to: blockNumber
        }
        const transactionData = await graphQLClient.request(transactionQuery, variables)

        if (transactionData.ethereum.smartContractCalls.length === 0)
            isEnded = true
        else 
            transactions = transactions.concat(transactionData.ethereum.smartContractCalls)

        console.log(`---- ${i} ---- ${transactionData.ethereum.smartContractCalls.length}`)
        i++;
    }

    console.log('\n<<<<<<<<<<<<------- Getting events data ------->>>>>>>>>>>>')
    let transactionsWithAmounts = [];
    i = 0;
    while (i < transactions.length) {
        const transaction = transactions[i];
        const eventData = await getSmartContractEventDataByHash(transaction.transaction.hash);

        const burnEvent = eventData.ethereum.smartContractEvents.find(row => row.smartContractEvent.name === 'Burn');
        const amount0 = burnEvent.arguments.find(row => row.argument === 'amount0')['value'];
        const amount1 = burnEvent.arguments.find(row => row.argument === 'amount1')['value'];

        let tokenA = null; let tokenB = null;
        if (transaction.smartContractMethod.name !== 'removeLiquidityWithPermit') {
            const withdrawalEvent = eventData.ethereum.smartContractEvents.find(row => row.smartContractEvent.name === 'Withdrawal');
            const wethAmount = withdrawalEvent.arguments.find(row => row.argument === 'wad')['value'];
            if (amount0 === wethAmount) {
                tokenA = {
                    address: wrappedCoinAddress,
                    amount: amount0
                }
                tokenB = {
                    address: transaction.arguments[0].value,
                    amount: amount1
                }
            } else {
                tokenA = {
                    address: transaction.arguments[0].value,
                    amount: amount0
                }
                tokenB = {
                    address: wrappedCoinAddress,
                    amount: amount1
                }
            }
        } else {
            tokenA = {
                address: transaction.arguments[0].value,
                amount: amount0
            }
            tokenB = {
                address: transaction.arguments[1].value,
                amount: amount1
            }
        }

        transactionsWithAmounts.push({
            block: transaction.block.height,
            method: transaction.smartContractMethod.name,
            transactionHash: transaction.transaction.hash,
            timeRemoved: transaction.block.timestamp.unixtime,
            caller: transaction.caller.address,
            tokenA,
            tokenB
        });

        console.log(`---- ${i} ----`);
        i++;
    }

    return transactionsWithAmounts;
}

const getTokenData = async (tokenAddressList) => {
    console.log('\n<<<<<<<<<<<<------- Getting token data ------->>>>>>>>>>>>')

    const tokenList = [];
    const tokenContractsQuery = gql`
        query ($network: EthereumNetwork!, $address: String!) {
            ethereum(network: $network) {
                address(address: {is: $address}) {
                    address
                    smartContract {
                        contractType
                        currency {
                            name
                            symbol
                            decimals
                        }
                    }
                }
            }
        }
    `
    i = 0;
    while (i < tokenAddressList.length) {
        const variables = {
            network,
            address: tokenAddressList[i]
        }
        const contractData = await graphQLClient.request(tokenContractsQuery, variables)
        console.log(`---- ${i} ----`);

        tokenList.push({
            address: contractData.ethereum.address[0].address,
            name: contractData.ethereum.address[0].smartContract.currency.name,
            symbol: contractData.ethereum.address[0].smartContract.currency.symbol,
            decimals: contractData.ethereum.address[0].smartContract.currency.decimals,
        })

        i++;
    }
    return tokenList;
}

const main = async () => {
    const latestBlockNumber = await getLatestBlock();

    const transactionsWithAmounts = await getTransactionData(latestBlockNumber);

    let objTokenAddressList = {}; const tokenAddressList = [];
    transactionsWithAmounts.forEach(row => {
        if (objTokenAddressList[row.tokenA.address.toLowerCase()] === undefined) {
            objTokenAddressList[row.tokenA.address.toLowerCase()] = true;
            tokenAddressList.push(row.tokenA.address)
        }
        if (objTokenAddressList[row.tokenB.address.toLowerCase()] === undefined) {
            objTokenAddressList[row.tokenB.address.toLowerCase()] = true;
            tokenAddressList.push(row.tokenB.address)
        }
    });

    const tokenList = await getTokenData(tokenAddressList);
    const objTokenList = tokenList.reduce((all, token) => {
        return {
            ...all,
            [token.address]: token
        }
    }, {});

    const result = transactionsWithAmounts.map(row => {
        return {
            block: row.block,
            method: row.method,
            transactionHash: row.transactionHash,
            timeRemoved: row.timeRemoved,
            caller: row.caller,
            tokenA: {
                ...row.tokenA,
                name: objTokenList[row.tokenA.address].name,
                symbol: objTokenList[row.tokenA.address].symbol,
                decimals: objTokenList[row.tokenA.address].decimals,
            },
            tokenB: {
                ...row.tokenB,
                name: objTokenList[row.tokenB.address].name,
                symbol: objTokenList[row.tokenB.address].symbol,
                decimals: objTokenList[row.tokenB.address].decimals,
            },
        }
    });

    fs.writeFileSync('./transactions.json', JSON.stringify(result, undefined, 2));
}
main().catch((error) => console.error(error))
