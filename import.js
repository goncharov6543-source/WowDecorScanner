document.addEventListener('DOMContentLoaded', () => {
    const btn = document.querySelector('.btn-import');
    
    btn.addEventListener('click', () => {
        const selectedCards = document.querySelectorAll('.item-card');
        const totals = {};
        let hasSelection = false;

        // 1. Проходимо по всіх картках
        selectedCards.forEach(card => {
            const checkbox = card.querySelector('.check-input');
            
            if (checkbox && checkbox.checked) {
                hasSelection = true;
                
                // Отримуємо кількість крафтів (якщо пусто — то 1)
                const input = card.querySelector('.qty-input');
                const multiplier = parseInt(input.value) || 1;

                // Отримуємо рецепт з прихованого атрибута
                // (Ми додамо цей атрибут в index.js)
                const recipeData = JSON.parse(card.dataset.recipe || '[]');

                // 2. Сумуємо реагенти
                recipeData.forEach(reagent => {
                    // Якщо реагента ще немає в списку — створюємо
                    if (!totals[reagent.name]) {
                        totals[reagent.name] = 0;
                    }
                    // Додаємо кількість * множник
                    totals[reagent.name] += (reagent.count * multiplier);
                });
            }
        });

        if (!hasSelection) {
            alert("Будь ласка, виберіть хоча б один предмет галочкою!");
            return;
        }

        if (Object.keys(totals).length === 0) {
            alert("У вибраних предметів немає рецептів (або це базові матеріали).");
            return;
        }

        // 3. Формуємо стрічку для Auctionator
        // Формат: ListName^"ItemName";;0;0;0;0;0;0;0;0;;#;;Qty^...
        let importString = "Decor Shopping List";

        for (const [name, count] of Object.entries(totals)) {
            // Екрануємо лапки, якщо є в назві
            const cleanName = name.replace(/"/g, '\\"');
            importString += `^"${cleanName}";;0;0;0;0;0;0;0;0;;#;;${count}`;
        }

        // 4. Копіюємо в буфер обміну
        navigator.clipboard.writeText(importString).then(() => {
            const originalText = btn.textContent;
            btn.textContent = "Скопійовано!";
            btn.style.background = "#4caf50"; // Зелений колір
            
            setTimeout(() => {
                btn.textContent = originalText;
                btn.style.background = ""; // Повертаємо колір
            }, 2000);
        }).catch(err => {
            console.error('Помилка копіювання:', err);
            alert("Стрічка сформована (див. консоль), але не вдалося скопіювати автоматично.");
        });
    });
});