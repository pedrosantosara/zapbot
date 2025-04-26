import pkg from 'whatsapp-web.js';
import qrcodeTerminal from 'qrcode-terminal';
import dotenv from 'dotenv';
import { GoogleGenAI } from "@google/genai";
import { MongoClient, ObjectId } from 'mongodb';
import cron from 'node-cron';

dotenv.config();
const { Client, LocalAuth } = pkg;
const genAI = new GoogleGenAI(process.env.GOOGLE_API_KEY);

let db;
const waitingForConfirmation = {};
const waitingForClarification = {};
const greetings = ["olá", "bom dia", "boa tarde", "boa noite"];

async function connectDB() {
    const uri = process.env.MONGODB_URI;
    const client = new MongoClient(uri, { 
        serverApi: { version: "1", strict: true, deprecationErrors: true }
    });
    await client.connect();
    db = client.db('financeBot');
    console.log("Conectado ao MongoDB");
}

connectDB();

async function generateAiResponse(prompt) {
    try {
        const response = await genAI.models.generateContent({
            model: "gemini-2.0-flash",
            contents: [{ role: "user", parts: [{ text: `Você é um assistente financeiro. ${prompt}` }] }],
        });
        return response.text.trim();
    } catch (error) {
        console.error("Erro na API Gemini:", error);
        return "Ops, algo deu errado. Tenta de novo!";
    }
}

async function getUser(userId) {
    const usersCollection = db.collection('users');
    let user = await usersCollection.findOne({ _id: userId });
    if (!user) {
        user = { _id: userId, balance: 0, spendingLimit: null, categories: [], reminderMode: false };
        await usersCollection.insertOne(user);
    }
    return user;
}

async function addTransaction(userId, type, amount, category, description, date = new Date(), fixedExpenseId = null) {
    const transactionsCollection = db.collection('transactions');
    const transaction = { userId, date, type, amount, category, description, fixedExpenseId };
    const result = await transactionsCollection.insertOne(transaction);
    const update = type === 'income' ? { $inc: { balance: amount } } : { $inc: { balance: -amount } };
    await db.collection('users').updateOne({ _id: userId }, update);
    return result.insertedId;
}

async function getBalance(userId) {
    const user = await db.collection('users').findOne({ _id: userId });
    return user.balance;
}

async function getLastTransactions(userId, limit) {
    return await db.collection('transactions').find({ userId }).sort({ date: -1 }).limit(limit).toArray();
}

async function deleteAllTransactions(userId) {
    await db.collection('transactions').deleteMany({ userId });
    await db.collection('users').updateOne({ _id: userId }, { $set: { balance: 0 } });
}

async function getCategoryFromAI(description, categories) {
    const prompt = `Categorize o item: '${description}'. Categorias disponíveis: ${categories.join(', ')}. Se nenhuma for adequada, sugira uma nova categoria. Responda apenas com o nome da categoria ou a sugestão.`;
    const response = await generateAiResponse(prompt);
    const suggestedCategory = response.trim().toLowerCase().replace(/sugestão:\s*/i, '');
    return categories.map(cat => cat.toLowerCase()).includes(suggestedCategory) ? suggestedCategory : { suggested: suggestedCategory };
}

async function addCategory(userId, categoryName) {
    await db.collection('users').updateOne({ _id: userId }, { $addToSet: { categories: categoryName } });
}

async function getTotalExpensesThisMonth(userId) {
    const { start, end } = getMonthStartEnd();
    const result = await db.collection('transactions').aggregate([
        { $match: { userId, type: 'expense', date: { $gte: start, $lte: end } } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
    ]).toArray();
    return result.length > 0 ? result[0].total : 0;
}

function getMonthStartEnd() {
    const now = new Date();
    return {
        start: new Date(now.getFullYear(), now.getMonth(), 1),
        end: new Date(now.getFullYear(), now.getMonth() + 1, 0)
    };
}

async function setBalance(userId, amount) {
    await db.collection('users').updateOne({ _id: userId }, { $set: { balance: amount } });
}

async function setSpendingLimit(userId, amount) {
    await db.collection('users').updateOne({ _id: userId }, { $set: { spendingLimit: amount } });
}

async function getMonthlyReport(userId) {
    const { start, end } = getMonthStartEnd();
    const transactions = await db.collection('transactions').find({ userId, date: { $gte: start, $lte: end } }).toArray();
    const report = {};
    let totalExpense = 0, totalIncome = 0;
    transactions.forEach(tx => {
        if (!report[tx.category]) report[tx.category] = { expense: 0, income: 0 };
        if (tx.type === 'expense') {
            report[tx.category].expense += tx.amount;
            totalExpense += tx.amount;
        } else {
            report[tx.category].income += tx.amount;
            totalIncome += tx.amount;
        }
    });
    let reportText = `📊 Relatório de ${start.toLocaleString('pt-BR', { month: 'long' })} ${start.getFullYear()}\n`;
    reportText += `💰 Receitas: ${totalIncome.toFixed(2)}\n`;
    reportText += `💸 Despesas: ${totalExpense.toFixed(2)}\n`;
    reportText += `📈 Saldo: ${(totalIncome - totalExpense).toFixed(2)}\n\n`;
    reportText += `Por categoria:\n`;
    for (const [cat, totals] of Object.entries(report)) {
        reportText += `- ${cat}: 💰 ${totals.income.toFixed(2)} | 💸 ${totals.expense.toFixed(2)}\n`;
    }
    return reportText;
}

async function analyzeIntent(message) {
    const prompt = `Analise a mensagem em português: "${message}". Determine a intenção do usuário entre:
    - adicionar uma despesa (ex.: "camisa 20")
    - adicionar uma receita (ex.: "salário 1850")
    - definir o saldo (ex.: "adicionar 1000 reais")
    - definir o limite de gastos (ex.: "limite 500")
    - gerar um relatório (ex.: "relatório do mês")
    - pedir ajuda (ex.: "como usar")
    - ver saldo (ex.: "mostrar saldo")
    - listar transações (ex.: "listar transações")
    - apagar todas as transações (ex.: "apagar tudo")
    - adicionar uma categoria (ex.: "adicionar categoria transporte")
    - listar categorias (ex.: "listar categorias")
    - ativar modo lembrete (ex.: "ativar modo lembrete")
    - desativar modo lembrete (ex.: "desativar modo lembrete")
    Para despesas, receitas e adicionar categoria, extraia a descrição, valor ou nome da categoria. Responda no formato:
    intenção: [intenção]
    descrição: [descrição]
    valor: [valor]
    nome: [nome da categoria]
    Se não for possível determinar, responda "intenção: incerto".`;
    const response = await generateAiResponse(prompt);
    const lines = response.split('\n');
    const intentLine = lines.find(line => line.startsWith('intenção:'));
    const descriptionLine = lines.find(line => line.startsWith('descrição:'));
    const valueLine = lines.find(line => line.startsWith('valor:'));
    const nameLine = lines.find(line => line.startsWith('nome:'));
    if (intentLine) {
        const intent = intentLine.split(':')[1].trim();
        const description = descriptionLine ? descriptionLine.split(':')[1].trim() : null;
        const value = valueLine ? parseFloat(valueLine.split(':')[1].trim()) : null;
        const name = nameLine ? nameLine.split(':')[1].trim() : null;
        return { intent, description, value, name };
    }
    return { intent: 'incerto' };
}

async function parseCommand(message, userId) {
    const analysis = await analyzeIntent(message);
    const ambiguousWords = ["transferência"];
    if (analysis.intent === 'adicionar uma despesa') {
        const { description, value } = analysis;
        if (!description || !value) return null;
        if (ambiguousWords.some(word => description.toLowerCase().includes(word))) {
            return { command: "clarify", description, value };
        }
        const categories = await getCategories(userId);
        let category = await getCategoryFromAI(description, categories);
        if (typeof category === 'object' && category.suggested) {
            const suggestedCategory = category.suggested;
            await client.sendMessage(userId, `Não achei categoria pra "${description}". Sugiro "${suggestedCategory}". Tá ok? (sim/não)`);
            const response = await waitForUserResponse(userId);
            if (response.toLowerCase() === 'sim') {
                await addCategory(userId, suggestedCategory);
                category = suggestedCategory;
            } else {
                return null;
            }
        }
        return { command: "add_expense", amount: value, description, category };
    } else if (analysis.intent === 'adicionar uma receita') {
        const { description, value } = analysis;
        if (!description || !value) return null;
        if (ambiguousWords.some(word => description.toLowerCase().includes(word))) {
            return { command: "clarify", description, value };
        }
        const categories = await getCategories(userId);
        let category = await getCategoryFromAI(description, categories);
        if (typeof category === 'object' && category.suggested) {
            const suggestedCategory = category.suggested;
            await client.sendMessage(userId, `Não achei categoria pra "${description}". Sugiro "${suggestedCategory}". Tá ok? (sim/não)`);
            const response = await waitForUserResponse(userId);
            if (response.toLowerCase() === 'sim') {
                await addCategory(userId, suggestedCategory);
                category = suggestedCategory;
            } else {
                return null;
            }
        }
        return { command: "add_income", amount: value, description, category };
    } else if (analysis.intent === 'definir o saldo') {
        const { value } = analysis;
        if (!value) return null;
        return { command: "set_balance", amount: value };
    } else if (analysis.intent === 'definir o limite de gastos') {
        const { value } = analysis;
        if (!value) return null;
        return { command: "set_limit", amount: value };
    } else if (analysis.intent === 'gerar um relatório') {
        return { command: "report" };
    } else if (analysis.intent === 'pedir ajuda') {
        return { command: "help" };
    } else if (analysis.intent === 'ver saldo') {
        return { command: "show_balance" };
    } else if (analysis.intent === 'listar transações') {
        return { command: "list_transactions" };
    } else if (analysis.intent === 'apagar todas as transações') {
        return { command: "delete_all" };
    } else if (analysis.intent === 'adicionar uma categoria') {
        const { name } = analysis;
        if (!name) return null;
        return { command: "add_category", name };
    } else if (analysis.intent === 'listar categorias') {
        return { command: "list_categories" };
    } else if (analysis.intent === 'ativar modo lembrete') {
        return { command: "activate_reminder" };
    } else if (analysis.intent === 'desativar modo lembrete') {
        return { command: "deactivate_reminder" };
    } else {
        return { command: "unknown" };
    }
}

async function waitForUserResponse(userId) {
    return new Promise(resolve => {
        const listener = msg => {
            if (msg.from === userId) {
                client.removeListener('message', listener);
                resolve(msg.body);
            }
        };
        client.on('message', listener);
        setTimeout(() => {
            client.removeListener('message', listener);
            resolve('timeout');
        }, 60000);
    });
}

async function getCategories(userId) {
    const user = await getUser(userId);
    return user.categories || [];
}

const helpMessage = `
Aqui estão algumas coisas que você pode fazer:
- Adicionar uma despesa: 'camisa 20'
- Adicionar uma receita: 'salário 1850'
- Ver seu saldo: 'mostrar saldo'
- Ver últimas transações: 'listar transações'
- Apagar todas as transações: 'apagar tudo'
- Gerar um relatório: 'relatório do mês'
- Adicionar uma categoria: 'adicionar categoria transporte'
- Listar categorias: 'listar categorias'
- Ativar modo lembrete: 'ativar modo lembrete'
- Desativar modo lembrete: 'desativar modo lembrete'
Se precisar de mais ajuda, diga 'ajuda'.
`;

const client = new Client({ authStrategy: new LocalAuth() });

client.once('ready', () => {
    console.log('Cliente WhatsApp pronto!');
    cron.schedule('0 0 1 * *', async () => {
        const users = await db.collection('users').find({}).toArray();
        for (const user of users) {
            const report = await getMonthlyReport(user._id);
            await client.sendMessage(user._id, `Resumo mensal:\n${report}`);
        }
    });
});

client.on('qr', qr => qrcodeTerminal.generate(qr, { small: true }));

client.on('message', async message => {
    if (!message.body || message.fromMe) return;
    const userId = message.from;

    if (waitingForClarification[userId]) {
        const { description, value } = waitingForClarification[userId];
        const response = message.body.toLowerCase().trim();
        if (response === 'receita' || response === 'despesa') {
            const type = response === 'receita' ? 'income' : 'expense';
            const categories = await getCategories(userId);
            let category = await getCategoryFromAI(description, categories);
            if (typeof category === 'object' && category.suggested) {
                const suggestedCategory = category.suggested;
                await client.sendMessage(userId, `Não achei categoria pra "${description}". Sugiro "${suggestedCategory}". Tá ok? (sim/não)`);
                const confirmResponse = await waitForUserResponse(userId);
                if (confirmResponse.toLowerCase() === 'sim') {
                    await addCategory(userId, suggestedCategory);
                    category = suggestedCategory;
                } else {
                    await client.sendMessage(userId, "Ok, não adicionei a categoria.");
                    delete waitingForClarification[userId];
                    return;
                }
            }
            const txId = await addTransaction(userId, type, value, category, description);
            let responseText = type === 'income' ? `Receita de ${value.toFixed(2)} em ${category} - ${description} (ID: ${txId}) adicionada!` : `Beleza, adicionei ${value.toFixed(2)} em ${category} - ${description} (ID: ${txId})`;
            if (type === 'expense') {
                const user = await getUser(userId);
                const totalExpenses = await getTotalExpensesThisMonth(userId);
                if (user.spendingLimit && totalExpenses > user.spendingLimit) {
                    responseText += "\nVocê passou do limite! 👎";
                } else if (user.spendingLimit) {
                    responseText += `\nAinda te sobra ${(user.spendingLimit - totalExpenses).toFixed(2)} pra gastar esse mês.`;
                }
                if (user.reminderMode) {
                    const balance = await getBalance(userId);
                    responseText += `\nCom base no seu saldo, você ainda pode gastar ${balance.toFixed(2)}.`;
                    if (balance < 0) {
                        responseText += ` Seu saldo está negativo em ${Math.abs(balance).toFixed(2)}.`;
                    }
                }
            }
            await client.sendMessage(userId, responseText);
            delete waitingForClarification[userId];
        } else {
            await client.sendMessage(userId, "Por favor, responda com 'receita' ou 'despesa'.");
        }
        return;
    }

    if (waitingForConfirmation[userId]) {
        waitingForConfirmation[userId] = false;
        if (message.body.toLowerCase().trim() === 'sim') {
            await deleteAllTransactions(userId);
            await client.sendMessage(userId, "Todas as transações foram apagadas.");
        } else {
            await client.sendMessage(userId, "Ação cancelada.");
        }
        return;
    }

    const command = await parseCommand(message.body, userId);
    let responseText = "";

    if (command && command.command !== "unknown") {
        const user = await getUser(userId);
        if (command.command === "add_expense") {
            const { amount, description, category } = command;
            const txId = await addTransaction(userId, 'expense', amount, category, description);
            responseText = `Beleza, adicionei ${amount.toFixed(2)} em ${category} - ${description} (ID: ${txId})`;
            const totalExpenses = await getTotalExpensesThisMonth(userId);
            if (user.spendingLimit && totalExpenses > user.spendingLimit) {
                responseText += "\nVocê passou do limite! 👎";
            } else if (user.spendingLimit) {
                responseText += `\nAinda te sobra ${(user.spendingLimit - totalExpenses).toFixed(2)} pra gastar esse mês.`;
            }
            if (user.reminderMode) {
                const balance = await getBalance(userId);
                responseText += `\nCom base no seu saldo, você ainda pode gastar ${balance.toFixed(2)}.`;
                if (balance < 0) {
                    responseText += ` Seu saldo está negativo em ${Math.abs(balance).toFixed(2)}.`;
                }
            }
        } else if (command.command === "add_income") {
            const { amount, description, category } = command;
            const txId = await addTransaction(userId, 'income', amount, category, description);
            responseText = `Receita de ${amount.toFixed(2)} em ${category} - ${description} (ID: ${txId}) adicionada!`;
        } else if (command.command === "set_balance") {
            await setBalance(userId, command.amount);
            responseText = `Saldo ajustado pra ${command.amount.toFixed(2)}.`;
        } else if (command.command === "set_limit") {
            await setSpendingLimit(userId, command.amount);
            responseText = `Limite de gastos definido em ${command.amount.toFixed(2)}.`;
        } else if (command.command === "report") {
            responseText = await getMonthlyReport(userId);
        } else if (command.command === "help") {
            responseText = helpMessage;
        } else if (command.command === "show_balance") {
            const balance = await getBalance(userId);
            responseText = `Seu saldo atual é: ${balance.toFixed(2)}`;
        } else if (command.command === "list_transactions") {
            const transactions = await getLastTransactions(userId, 10);
            let text = "Últimas 10 transações:\n";
            transactions.forEach(tx => {
                text += `- ${tx.date.toLocaleString('pt-BR')} | ${tx.type === 'expense' ? 'Gasto' : 'Receita'}: ${tx.amount.toFixed(2)} em ${tx.category} - ${tx.description} (ID: ${tx._id})\n`;
            });
            responseText = text || "Nenhuma transação por aqui.";
        } else if (command.command === "delete_all") {
            waitingForConfirmation[userId] = true;
            responseText = "Tem certeza que deseja apagar todas as suas transações? Isso não pode ser desfeito. Responda 'sim' para confirmar.";
            setTimeout(() => {
                if (waitingForConfirmation[userId]) {
                    waitingForConfirmation[userId] = false;
                    client.sendMessage(userId, 'Ação cancelada por timeout.');
                }
            }, 60000);
        } else if (command.command === "add_category") {
            const { name } = command;
            if (user.categories.includes(name)) {
                responseText = "Essa categoria já existe.";
            } else {
                await addCategory(userId, name);
                responseText = `Categoria '${name}' adicionada!`;
            }
        } else if (command.command === "list_categories") {
            const categories = user.categories;
            responseText = categories.length > 0 ? `Suas categorias são: ${categories.join(", ")}` : "Você não tem nenhuma categoria ainda.";
        } else if (command.command === "activate_reminder") {
            await db.collection('users').updateOne({ _id: userId }, { $set: { reminderMode: true } });
            responseText = "Modo lembrete ativado. Vou te avisar quanto você ainda pode gastar após cada despesa.";
        } else if (command.command === "deactivate_reminder") {
            await db.collection('users').updateOne({ _id: userId }, { $set: { reminderMode: false } });
            responseText = "Modo lembrete desativado.";
        } else if (command.command === "clarify") {
            const { description, value } = command;
            waitingForClarification[userId] = { description, value };
            responseText = "Não tenho certeza se isso é uma receita ou uma despesa. Por favor, esclareça respondendo 'receita' ou 'despesa'.";
        }
    } else if (greetings.includes(message.body.toLowerCase().trim())) {
        responseText = "Olá! " + helpMessage;
    } else {
        responseText = "Não entendi sua mensagem. " + helpMessage;
    }

    await client.sendMessage(userId, responseText);
    await saveLog(userId, message.body, responseText);
});

async function saveLog(userId, message, response) {
    await db.collection('logs').insertOne({
        userId,
        timestamp: new Date(),
        message,
        response
    });
}

client.initialize().catch(err => console.error("Erro no WhatsApp:", err));