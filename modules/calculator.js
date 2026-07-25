// modules/calculator.js

const MAX_EXPRESSION_LENGTH = 100

class ArithmeticParser {
    constructor(input) {
        this.input = input
        this.index = 0
    }

    parse() {
        const value = this.parseExpression()
        this.skipSpaces()
        if (this.index < this.input.length) {
            throw new Error("Ekspresi tidak valid")
        }
        return value
    }

    skipSpaces() {
        while (this.input[this.index] === " ") this.index += 1
    }

    peek() {
        this.skipSpaces()
        return this.input[this.index]
    }

    eat(char) {
        this.skipSpaces()
        if (this.input[this.index] === char) {
            this.index += 1
            return true
        }
        return false
    }

    parseExpression() {
        let value = this.parseTerm()

        while (true) {
            if (this.eat("+")) value += this.parseTerm()
            else if (this.eat("-")) value -= this.parseTerm()
            else break
        }

        return value
    }

    parseTerm() {
        let value = this.parsePower()

        while (true) {
            if (this.eat("*")) value *= this.parsePower()
            else if (this.eat("/")) {
                const divisor = this.parsePower()
                if (divisor === 0) throw new Error("Tidak bisa membagi dengan nol")
                value /= divisor
            } else if (this.eat("%")) {
                const divisor = this.parsePower()
                if (divisor === 0) throw new Error("Tidak bisa modulo nol")
                value %= divisor
            } else break
        }

        return value
    }

    parsePower() {
        let value = this.parseUnary()
        if (this.eat("^")) {
            const exponent = this.parsePower()
            value = value ** exponent
        }
        return value
    }

    parseUnary() {
        if (this.eat("+")) return this.parseUnary()
        if (this.eat("-")) return -this.parseUnary()
        return this.parsePrimary()
    }

    parsePrimary() {
        if (this.eat("(")) {
            const value = this.parseExpression()
            if (!this.eat(")")) throw new Error("Kurung tutup kurang")
            return value
        }

        return this.parseNumber()
    }

    parseNumber() {
        this.skipSpaces()

        const start = this.index
        while (/[0-9.]/.test(this.input[this.index] || "")) {
            this.index += 1
        }

        if (start === this.index) throw new Error("Angka tidak valid")

        const raw = this.input.slice(start, this.index)
        if ((raw.match(/\./g) || []).length > 1) throw new Error("Angka tidak valid")

        const value = Number(raw)
        if (!Number.isFinite(value)) throw new Error("Angka tidak valid")
        return value
    }
}

function normalizeExpression(expr) {
    return String(expr || "")
        .trim()
        .replace(/[\u00d7xX]/g, "*")
        .replace(/\u00f7/g, "/")
        .replace(/,/g, ".")
        .replace(/\s+/g, " ")
}

function formatResult(value) {
    if (!Number.isFinite(value)) throw new Error("Hasil tidak valid")
    if (Number.isInteger(value)) return String(value)
    return Number(value.toFixed(10)).toString()
}

function calculate(expr) {
    const clean = normalizeExpression(expr)
    if (!clean) throw new Error("Ekspresi kosong")
    if (clean.length > MAX_EXPRESSION_LENGTH) throw new Error("Ekspresi terlalu panjang")
    if (!/^[0-9+\-*/%^().\s]+$/.test(clean)) throw new Error("Hanya angka dan operator dasar yang didukung")

    const result = new ArithmeticParser(clean).parse()
    return formatResult(result)
}

module.exports = { calculate }
