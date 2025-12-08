// --- Module 1 Bonus: The Health Check ---

// 1. Create a variable 'hp' (Health Points) with value 100
// let hp = ...
let hp = 100;

// 2. Create a function 'takeDamage'
//    - Input: 'amount'
//    - Logic: Subtract 'amount' from 'hp'
//    - Logic: If 'hp' is less than or equal to 0, print "Game Over!"
//    - Logic: Else, print "HP is now: " + hp
function takeDamage(amount) {
    hp = hp - amount;
    if (hp <= 0) {
        console.log("Game Over!");
    }
    return hp;

}


// 3. Call the function with damage 50
takeDamage(50);
console.log(hp);

// 4. Call the function with damage 60 (Should trigger Game Over)
takeDamage(60);
console.log(hp);